import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { fixture } from '@cindy/kos-workbench/qa-fixture';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LIBRARY_SCHEMA_2, LIBRARY_SCHEMA_3 } from '../../../../../../packages/kos-workbench/src/library/storage';
import { LibrarySqlService } from '../../cindy-brain/librarySqlService';
import { createLibraryDbCore, type SqliteDatabaseConstructor } from '../../cindy-brain/libraryDbCore';
import { createKosRelayTransport, type KosRelayTransport } from '../kosRelayTransport';
import { openStagedKosLibrary } from '../kosStagedLibrary';
import { stageKosMigration } from '../kosMigrationImport';
import { inspectKosMigrationSnapshot } from '../kosMigrationPreflight';

// Unit, using the real staged SQLite format. Before cutover, referenced bytes
// must verify and incomplete WAL copies must be refused. The preview recovery
// tests use JSON and cannot catch these failures. Minimal input: one outbox blob
// with altered bytes, or one journal sidecar next to the staged copy.
describe('KOS migration snapshot preflight', () => {
  let root: string;
  let database: string;
  const origin = 'https://fixture.invalid';
  const namespace = `relay:${origin}`;
  const text = 'Offline draft';
  const hash = createHash('sha256').update(text).digest('hex');

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'kos-migration-'));
    database = path.join(root, 'umeda-library.sqlite');
    const db = new Database(database);
    try {
      db.exec('CREATE TABLE library_values (key TEXT PRIMARY KEY, value TEXT)');
      for (const sql of [...LIBRARY_SCHEMA_2, ...LIBRARY_SCHEMA_3]) db.exec(sql);
      db.pragma('user_version = 3');
      db.prepare('INSERT INTO library_queues VALUES (?, ?)').run('plugin', `${namespace}:pending`);
      db.prepare('INSERT INTO library_outbox VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run('plugin', `${namespace}:pending`, 0, 'edit-one', 'notes', 'card.md', 0, 1, hash);
    } finally {
      db.close();
    }
    await mkdir(path.join(root, 'content'));
    await writeFile(path.join(root, 'content', hash), text);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('checks the outbox content without changing the source database', async () => {
    const before = await readFile(database);
    const report = await inspectKosMigrationSnapshot(root);
    expect(report).toMatchObject({ counts: { library_outbox: 1 }, verifiedContent: 1, invalidContent: 0, indexedDb: 'unverified' });
    await writeFile(path.join(root, 'content', hash), 'Changed draft');
    expect(await inspectKosMigrationSnapshot(root)).toMatchObject({ verifiedContent: 0, invalidContent: 1 });
    expect(await readFile(database)).toEqual(before);
  });

  it('stages a verified copy and imports only IndexedDB keys missing from legacy SQLite', async () => {
    const source = path.join(root, 'source');
    await mkdir(source);
    await rename(database, path.join(source, 'umeda-library.sqlite'));
    await rename(path.join(root, 'content'), path.join(source, 'content'));
    const db = new Database(path.join(source, 'umeda-library.sqlite'));
    db.prepare('INSERT INTO library_values VALUES (?, ?)').run('draft:existing', 'newer SQLite draft');
    db.prepare('INSERT INTO library_catalogs VALUES (?, ?, ?)').run('plugin', `${namespace}:catalog`, JSON.stringify({
      vaults: [{ id: 'notes', name: 'KOS' }], cursors: {}, updatedAt: 0,
    }));
    db.close();

    const hostExport = path.join(root, 'indexeddb.json');
    const destination = path.join(root, 'staged');
    const readingKey = `${namespace}:preference:${encodeURIComponent('reading:position')}`;
    await writeFile(hostExport, JSON.stringify([['draft:existing', 'old draft'], [readingKey, JSON.stringify('page 3')]]));
    const result = await stageKosMigration(source, hostExport, destination, origin);
    expect(result).toMatchObject({ status: 'staged', indexedDbEntries: 2, importedValues: 1, verifiedContent: 1 });
    const target = new Database(path.join(destination, 'umeda-library.sqlite'), { readonly: true });
    try {
      expect(target.prepare('SELECT * FROM library_values ORDER BY key').all()).toEqual([
        { key: 'draft:existing', value: 'newer SQLite draft' },
        { key: readingKey, value: JSON.stringify('page 3') },
      ]);
      expect(target.prepare('SELECT id FROM library_outbox').all()).toEqual([{ id: 'edit-one' }]);
    } finally {
      target.close();
    }
    const open = (transport?: KosRelayTransport) => openStagedKosLibrary(destination, () => new LibrarySqlService({
      workerScriptPath: () => '',
      betterSqliteModulePath: () => '',
      inProcessCtor: Database as unknown as SqliteDatabaseConstructor,
      createCore: DatabaseCtor => createLibraryDbCore({ DatabaseCtor }),
    }), transport);
    const session = await open();
    expect(session).not.toBeNull();
    try {
      const service = session!.service;
      expect(service.files('notes')).toEqual([expect.objectContaining({ path: 'card.md' })]);
      expect(service.getSnapshot().pending).toEqual([expect.objectContaining({ id: 'edit-one', text })]);
      expect(await service.preference('reading:position', '')).toBe('page 3');
      await service.savePreference('reading:position', 'page 4');
      await service.saveText('notes', 'new.md', '# Written by the built-in host', 0);
    } finally {
      await session!.close();
    }
    const reopened = await open();
    try {
      expect(await reopened!.service.preference('reading:position', '')).toBe('page 4');
      expect(reopened!.service.getSnapshot().pending).toEqual([
        expect.objectContaining({ id: 'edit-one', text }),
        expect.objectContaining({ path: 'new.md', text: '# Written by the built-in host' }),
      ]);
    } finally {
      await reopened!.close();
    }

    const relay = fixture();
    await relay.initialize();
    let ownsWriter = true;
    let fileWrites = 0;
    const request: typeof fetch = async (input, init) => {
      const url = new URL(String(input));
      if (init?.method === 'PUT' && url.pathname.endsWith('/file')) fileWrites += 1;
      const result = await relay.callHttp(url.pathname + url.search, init?.method, init?.body as string | undefined, init?.headers as Record<string, string> | undefined);
      return new Response(result.body, { status: result.status });
    };
    const transport = () => createKosRelayTransport(origin, () => ownsWriter, request);
    const connected = await open(transport());
    try {
      expect(connected!.service.getSnapshot().pending).toHaveLength(0);
      expect(fileWrites).toBe(2);
    } finally {
      await connected!.close();
    }
    const afterSync = await open(transport());
    try {
      expect(fileWrites).toBe(2);
      expect(await afterSync!.service.readText('notes', afterSync!.service.files('notes').find(file => file.path === 'card.md')!)).toBe(text);
      ownsWriter = false;
      await afterSync!.service.saveText('notes', 'fenced.md', '# Still local', 0);
      await afterSync!.service.refresh();
      expect(afterSync!.service.getSnapshot().pending).toHaveLength(1);
      expect(fileWrites).toBe(2);
    } finally {
      await afterSync!.close();
    }

    await expect(stageKosMigration(source, hostExport, destination, origin)).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(path.join(destination, 'kos-migration-receipt.json'), 'utf8')).toBe(JSON.stringify(result));
  });

  it('refuses a snapshot still carrying a WAL sidecar', async () => {
    await writeFile(database + '-wal', '');
    await expect(inspectKosMigrationSnapshot(root)).rejects.toThrow('KOS_SNAPSHOT_REQUIRES_CHECKPOINT');
  });
});
