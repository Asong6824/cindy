import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

const databaseName = 'umeda-library.sqlite';
const hashPattern = /^[a-f0-9]{64}$/;
const tables = ['library_values', 'library_kv', 'library_catalogs', 'library_content', 'library_outbox', 'library_moves'] as const;

async function hashFile(file: string): Promise<string | null> {
  let handle;
  try {
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile() || stat.dev !== opened.dev || stat.ino !== opened.ino) return null;
    const digest = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest('hex');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  } finally {
    await handle?.close();
  }
}

/** Inspect an explicitly staged, quiescent replica. No live binding or plugin process is used. */
export async function inspectKosMigrationSnapshot(directory: string) {
  const root = await realpath(directory);
  const dbFile = path.join(root, databaseName);
  if (!(await lstat(dbFile)).isFile() || await realpath(dbFile) !== dbFile) throw new Error('KOS_SNAPSHOT_INVALID_DATABASE');
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const exists = await lstat(dbFile + suffix).then(() => true, (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return false;
      throw error;
    });
    if (exists) throw new Error('KOS_SNAPSHOT_REQUIRES_CHECKPOINT');
  }

  const db = new Database(dbFile, { readonly: true, fileMustExist: true });
  try {
    db.pragma('trusted_schema = OFF');
    const version = db.pragma('user_version', { simple: true });
    if (version !== 1 && version !== 2 && version !== 3) throw new Error('KOS_SNAPSHOT_UNSUPPORTED_SCHEMA');
    if (db.pragma('quick_check', { simple: true }) !== 'ok') throw new Error('KOS_SNAPSHOT_DATABASE_CORRUPT');

    const schema = db.prepare('SELECT type, sql FROM sqlite_schema WHERE name = ?');
    const required = version === 1 ? tables.slice(0, 1) : version === 2 ? tables.slice(0, -1) : tables;
    const counts = Object.fromEntries(required.map(table => {
      const entry = schema.get(table) as { type: string; sql: string } | undefined;
      if (entry?.type !== 'table' || !/^CREATE TABLE\b/i.test(entry.sql)) throw new Error('KOS_SNAPSHOT_INVALID_SCHEMA');
      return [table, (db.prepare(`SELECT count(*) AS count FROM ${table}`).get() as { count: number }).count];
    }));

    let invalidContent = 0;
    let verifiedContent = 0;
    if (version >= 2 && (counts.library_content || counts.library_outbox)) {
      const content = path.join(root, 'content');
      const safeDirectory = await realpath(content).then(actual => actual === content, (error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return false;
        throw error;
      });
      const references = db.prepare('SELECT hash FROM library_content WHERE hash IS NOT NULL UNION SELECT content_hash FROM library_outbox');
      for (const { hash } of references.iterate() as Iterable<{ hash: string }>) {
        if (!safeDirectory || typeof hash !== 'string' || !hashPattern.test(hash) || await hashFile(path.join(content, hash)) !== hash) {
          invalidContent += 1;
        } else {
          verifiedContent += 1;
        }
      }
    }
    return { version, counts, invalidContent, verifiedContent, indexedDb: 'unverified' as const };
  } finally {
    db.close();
  }
}
