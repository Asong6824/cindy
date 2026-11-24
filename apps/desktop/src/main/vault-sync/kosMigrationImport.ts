import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, readdir, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import { atomicWriteFileSync } from '../utils/atomicWriteFile';
import { inspectKosMigrationSnapshot } from './kosMigrationPreflight';

/**
 * Stage a detached library from a quiescent SQLite snapshot and an explicit
 * export of the old plugin's IndexedDB values store. The destination is private
 * to this import. The receipt certifies the copy, never authorizes it to write.
 */
export async function stageKosMigration(source: string, indexedDbExport: string, destination: string, relayOrigin: string) {
  const origin = new URL(relayOrigin);
  if (origin.protocol !== 'https:' || origin.origin !== relayOrigin) throw new Error('KOS_MIGRATION_INVALID_ORIGIN');
  const namespace = `relay:${origin.origin}`;
  const sourceReport = await inspectKosMigrationSnapshot(source);
  if (sourceReport.invalidContent) throw new Error('KOS_MIGRATION_CONTENT_INVALID');

  const exported: unknown = JSON.parse(await readFile(indexedDbExport, 'utf8'));
  const values = new Map<string, string>();
  if (!Array.isArray(exported)) throw new Error('KOS_MIGRATION_INVALID_INDEXED_DB');
  for (const entry of exported) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== 'string'
      || typeof entry[1] !== 'string' || values.has(entry[0])) {
      throw new Error('KOS_MIGRATION_INVALID_INDEXED_DB');
    }
    values.set(entry[0], entry[1]);
  }

  const src = await realpath(source);
  const parent = await realpath(path.dirname(destination));
  const target = path.join(parent, path.basename(destination));
  const relative = path.relative(src, target);
  if (!relative || (relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative))) {
    throw new Error('KOS_MIGRATION_TARGET_INSIDE_SOURCE');
  }

  await mkdir(target, { mode: 0o700 });
  const databaseName = 'umeda-library.sqlite';
  const dbFile = path.join(target, databaseName);
  await copyFile(path.join(src, databaseName), dbFile, constants.COPYFILE_EXCL);
  const sourceContent = path.join(src, 'content');
  const contentDir = path.join(target, 'content');
  let copiedObjects = 0;
  const contentStat = await lstat(sourceContent).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (contentStat) {
    if (!contentStat.isDirectory() || await realpath(sourceContent) !== sourceContent) {
      throw new Error('KOS_MIGRATION_CONTENT_INVALID');
    }
    await mkdir(contentDir, { mode: 0o700 });
    for (const item of await readdir(sourceContent, { withFileTypes: true })) {
      if (!/^[a-f0-9]{64}$/.test(item.name)) continue;
      if (!item.isFile()) throw new Error('KOS_MIGRATION_CONTENT_INVALID');
      await copyFile(path.join(sourceContent, item.name), path.join(contentDir, item.name), constants.COPYFILE_EXCL);
      copiedObjects += 1;
    }
  }

  const db = new Database(dbFile, { fileMustExist: true });
  let importedValues: number;
  try {
    db.pragma('trusted_schema = OFF');
    if (db.prepare("SELECT 1 FROM sqlite_schema WHERE type = 'trigger'").get()) {
      throw new Error('KOS_MIGRATION_INVALID_SCHEMA');
    }
    // The plugin consults SQLite's legacy value table before IndexedDB. Import
    // only missing rows, leaving structured values and tombstones authoritative.
    const put = db.prepare('INSERT INTO library_values (key, value) VALUES (?, ?) ON CONFLICT(key) DO NOTHING');
    importedValues = db.transaction(() => {
      let imported = 0;
      for (const [key, value] of values) imported += put.run(key, value).changes;
      return imported;
    })();
    const tables = sourceReport.version === 1
      ? ['library_values']
      : ['library_values', 'library_kv', 'library_catalogs', 'library_queues', 'library_content'];
    const prefix = `${namespace}:`;
    const containsNamespace = tables.some(table =>
      db.prepare(`SELECT 1 FROM ${table} WHERE substr(key,1,length(?))=? LIMIT 1`).get(prefix, prefix));
    if (!containsNamespace) throw new Error('KOS_MIGRATION_NAMESPACE_NOT_FOUND');
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }

  const destinationReport = await inspectKosMigrationSnapshot(target);
  if (destinationReport.invalidContent || destinationReport.verifiedContent !== sourceReport.verifiedContent
    || destinationReport.version !== sourceReport.version
    || Object.entries(sourceReport.counts).some(([name, count]) => destinationReport.counts[name]
      !== (name === 'library_values' ? count + importedValues : count))) {
    throw new Error('KOS_MIGRATION_VERIFICATION_FAILED');
  }
  const receipt = {
    version: 1,
    status: 'staged' as const,
    namespace,
    databaseVersion: destinationReport.version,
    counts: destinationReport.counts,
    indexedDbEntries: values.size,
    importedValues,
    copiedObjects,
    verifiedContent: destinationReport.verifiedContent,
  };
  atomicWriteFileSync(path.join(target, 'kos-migration-receipt.json'), JSON.stringify(receipt));
  return receipt;
}
