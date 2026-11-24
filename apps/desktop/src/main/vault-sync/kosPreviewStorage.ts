import { fixture } from '@cindy/kos-workbench/qa-fixture';
import { LibraryService } from '@cindy/kos-workbench/library-service';
import { atomicWriteFileSync, readAtomicFileSync } from '../utils/atomicWriteFile';

const MAX_STATE_BYTES = 16 * 1024 * 1024;
type Entry = { key: string; value: string | null };

function persist(file: string, values: Map<string, string>) {
  const data = JSON.stringify({ version: 1, values: Object.fromEntries(values) });
  if (Buffer.byteLength(data) > MAX_STATE_BYTES) throw new Error('KOS_PREVIEW_STORAGE_LIMIT');
  atomicWriteFileSync(file, data);
}

async function seed() {
  const data = fixture();
  await data.initialize();
  await data.seed('cards/welcome.md', '---\ntype: card\ncard_id: preview-welcome\ntitle: KOS\n---\n# KOS\n');
  const service = new LibraryService(data.host);
  try {
    await service.initialize();
    const card = service.files('notes').find(file => file.path === 'cards/welcome.md');
    if (!card) throw new Error('KOS_PREVIEW_SEED_MISSING');
    await service.readText('notes', card);
    return data.local;
  } finally {
    service.dispose();
  }
}

export async function openKosPreviewLibrary(file: string): Promise<LibraryService> {
  const stored = readAtomicFileSync(file);
  let values: Map<string, string>;
  if (stored === null) {
    values = await seed();
    persist(file, values);
  } else {
    const state = JSON.parse(stored);
    if (state?.version !== 1 || !state.values || typeof state.values !== 'object'
      || Array.isArray(state.values) || Object.values(state.values).some(value => typeof value !== 'string')) {
      throw new Error('KOS_PREVIEW_INVALID_STORAGE');
    }
    values = new Map(Object.entries(state.values));
  }

  const commit = (entries: Entry[]) => {
    const next = new Map(values);
    for (const { key, value } of entries) {
      if (value === null) next.delete(key);
      else next.set(key, value);
    }
    persist(file, next);
    values = next;
  };
  const host: ConstructorParameters<typeof LibraryService>[0] = {
    async call<T>(operation: string, raw?: unknown): Promise<T> {
      if (operation === 'info') return { namespace: 'fixture', atomic: true } as T;
      if (operation === 'http') throw new Error('当前使用本机示例资料库，编辑会保存在本机。');
      if (operation === 'commit') {
        commit((raw as { entries: Entry[] }).entries);
        return undefined as T;
      }
      const { key, value } = raw as Entry;
      if (operation === 'get') return (values.get(key) ?? null) as T;
      if (operation === 'set' || operation === 'remove') {
        commit([{ key, value: operation === 'remove' ? null : value }]);
        return undefined as T;
      }
      throw new Error('KOS_PREVIEW_UNSUPPORTED_STORAGE_OPERATION');
    },
  };
  const service = new LibraryService(host);
  try {
    await service.initialize();
    return service;
  } catch (error) {
    service.dispose();
    throw error;
  }
}
