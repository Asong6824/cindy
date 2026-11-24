import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { LibraryService } from '@cindy/kos-workbench/library-service';
import { createLibraryStorage, LIBRARY_SCHEMA_2, LIBRARY_SCHEMA_3 } from '@cindy/kos-workbench/library-storage';
import { LibrarySqlService, defaultLibraryDbWorkerPath } from '../cindy-brain/librarySqlService';
import { resolveBetterSqliteModuleEntry, resolveBetterSqliteNativeBinding } from '../localDb/betterSqliteFactory';
import type { KosRelayTransport } from './kosRelayTransport';
import { VaultFolder } from './disk';

const receiptName = 'kos-migration-receipt.json';
type Entry = { key: string; value: string | null };

function createDatabaseWorker() {
  return new LibrarySqlService({
    workerScriptPath: defaultLibraryDbWorkerPath,
    betterSqliteModulePath: () => resolveBetterSqliteModuleEntry() ?? 'better-sqlite3',
    betterSqliteNativeBinding: resolveBetterSqliteNativeBinding,
  });
}

function value<T>(result: { ok: true } & T | { ok: false; code: string }): T {
  if (!result.ok) throw new Error(result.code);
  return result;
}

async function existingDirectory(directory: string) {
  const info = await lstat(directory).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw error;
  });
  if (info && !info.isDirectory()) throw new Error('KOS_STAGED_INVALID_DIRECTORY');
  return info !== null;
}

/** Open only a detached staged library. An explicit host-owned transport is required to submit its outbox. */
export async function openStagedKosLibrary(directory: string, createWorker = createDatabaseWorker, transport?: KosRelayTransport) {
  if (!await existingDirectory(directory)) return null;
  const root = await realpath(directory);
  const receiptPath = path.join(root, receiptName);
  const dbPath = path.join(root, 'umeda-library.sqlite');
  for (const file of [receiptPath, dbPath]) {
    if (!(await lstat(file)).isFile()) throw new Error('KOS_STAGED_INVALID_FILE');
  }
  const data = JSON.parse(await readFile(receiptPath, 'utf8'));
  if (data?.version !== 1 || data?.status !== 'staged' || typeof data.namespace !== 'string'
    || !data.namespace.startsWith('relay:')) throw new Error('KOS_STAGED_INVALID_RECEIPT');
  const origin = new URL(data.namespace.slice('relay:'.length));
  if (origin.protocol !== 'https:' || data.namespace !== `relay:${origin.origin}`) {
    throw new Error('KOS_STAGED_INVALID_NAMESPACE');
  }

  if (transport && origin.origin !== transport.origin) throw new Error('KOS_RELAY_NAMESPACE_MISMATCH');
  const worker = createWorker();
  const disk = new VaultFolder(root, path.join(root, '.unused-history'));
  try {
    value(await worker.open(dbPath));
    const version = value(await worker.userVersion(dbPath)).version;
    if (version !== 1 && version !== 2 && version !== 3) throw new Error('KOS_STAGED_UNSUPPORTED_SCHEMA');
    value(await worker.migrate(dbPath, 3, [
      { toVersion: 2, sql: LIBRARY_SCHEMA_2 },
      { toVersion: 3, sql: LIBRARY_SCHEMA_3 },
    ]));

    const blobPath = (hash: string) => {
      if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('KOS_STAGED_INVALID_HASH');
      return `content/${hash}`;
    };
    const readBlob = async (hash: string) => disk.read(blobPath(hash)).catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    const storage = createLibraryStorage('plugin', {
      async rows<T>(sql: string, params = []) {
        return value(await worker.exec(dbPath, sql, params)).rows as T[];
      },
      async batch(statements, current) {
        if (!current()) throw new Error('KOS_STAGED_CLOSED');
        value(await worker.batch(dbPath, statements));
      },
      async legacy(key) {
        const result = value(await worker.exec(dbPath, 'SELECT value FROM library_values WHERE key = ?', [key]));
        return (result.rows as { value: string | null }[])[0]?.value ?? null;
      },
      readBlob,
      async writeBlob(hash, bytes) {
        try {
          await disk.replace(blobPath(hash), bytes, null);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const prior = await readBlob(hash);
          if (!prior || disk.hash(prior) !== hash) throw new Error('KOS_STAGED_CONTENT_CORRUPT');
        }
      },
    });
    const service = new LibraryService({
      async call<T>(operation: string, raw?: unknown): Promise<T> {
        if (operation === 'info') return { namespace: data.namespace, atomic: true } as T;
        if (operation === 'http') {
          if (!transport) throw new Error('迁移副本处于离线验证模式，编辑会保存在本机。');
          return await transport.call(raw as Parameters<KosRelayTransport['call']>[0]) as T;
        }
        if (operation === 'commit') {
          await storage.commit((raw as { entries: Entry[] }).entries);
          return undefined as T;
        }
        const { key, value } = raw as Entry;
        if (operation === 'get') return await storage.get(key) as T;
        if (operation === 'set' || operation === 'remove') {
          await storage.set(key, operation === 'remove' ? null : value);
          return undefined as T;
        }
        throw new Error('KOS_STAGED_UNSUPPORTED_STORAGE_OPERATION');
      },
    });
    await service.initialize();
    return { service, async close() { service.dispose(); transport?.stop(); await worker.dispose(); } };
  } catch (error) {
    transport?.stop();
    await worker.dispose();
    throw error;
  }
}
