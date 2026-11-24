import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { KOS_PREVIEW_AVAILABLE, KOS_PREVIEW_CHANGED, KOS_PREVIEW_COMMAND } from '../../../shared/kosPreview';
import { LibraryClient } from '@cindy/kos-workbench/library-client';
import { registerKosPreviewIpc } from '../kosPreview';

const state = vi.hoisted(() => ({
  mock: false,
  userData: '',
  packaged: false,
  trusted: true,
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  send: vi.fn(),
}));
vi.mock('electron', () => ({
  app: { get isPackaged() { return state.packaged; }, getPath: () => state.userData },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: state.send } }] },
  ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => state.handlers.set(channel, handler) },
}));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../../localDb/uiMockSeed', () => ({ isUiMockDataEnabled: () => state.mock }));
vi.mock('../../security/trustedAppRenderer', () => ({
  isTrustedAppRendererWindow: () => true,
  assertTrustedAppRendererEvent: () => { if (!state.trusted) throw new Error('UNTRUSTED'); },
}));

// Unit: Electron ingress, fixture-only gating, and acknowledged edits visible on
// reopening the workspace after host recreation. Existing library tests do not
// exercise desktop IPC with disk recovery. Minimal inputs: one offline edit or
// an unsupported snapshot version. Local storage must preserve unreadable state.
describe('KOS desktop preview', () => {
  const event = { sender: { isDestroyed: () => false, send: state.send } };
  const command = (input: unknown) => state.handlers.get(KOS_PREVIEW_COMMAND)!(event, input);

  beforeEach(async () => {
    state.userData = await mkdtemp(path.join(tmpdir(), 'kos-preview-'));
    state.mock = false;
    state.packaged = false;
    state.trusted = true;
    state.handlers.clear();
    state.send.mockClear();
  });

  afterEach(async () => {
    await rm(state.userData, { recursive: true, force: true });
  });

  it.each([[false, false], [true, true]])('keeps preview commands unavailable outside isolated mock development', (mock, packaged) => {
    state.mock = mock;
    state.packaged = packaged;
    registerKosPreviewIpc();
    expect(state.handlers.get(KOS_PREVIEW_AVAILABLE)!(event)).toBe(false);
    expect(state.handlers.has(KOS_PREVIEW_COMMAND)).toBe(false);
  });

  it('rejects an untrusted frame and recovers an offline edit and its draft preference in a new host', async () => {
    state.mock = true;
    registerKosPreviewIpc();
    expect(state.handlers.get(KOS_PREVIEW_AVAILABLE)!(event)).toBe(true);
    state.trusted = false;
    await expect(command({ command: 'ready' })).rejects.toThrow('UNTRUSTED');
    state.trusted = true;
    await command({ command: 'saveText', args: { vaultId: 'notes', path: 'cards/example.md', text: '# Example', baseRevision: 0 } });
    await command({ command: 'savePreference', args: { key: 'draft:example', value: 'draft text' } });
    // Re-register with a fresh service closure, preserving only the on-disk profile.
    state.handlers.clear();
    registerKosPreviewIpc();
    const reopened = new LibraryClient({ call: async <T,>(_operation: string, request?: unknown) => await command(request) as T }, () => () => {});
    await reopened.ready();
    const file = reopened.files('notes').find(candidate => candidate.path === 'cards/example.md');
    expect(file).toBeDefined();
    await expect(reopened.readText('notes', file!)).resolves.toBe('# Example');
    expect(await reopened.preference('draft:example', '')).toBe('draft text');
    expect(reopened.getSnapshot().pending).toHaveLength(1);
    expect(state.send).toHaveBeenCalledWith(KOS_PREVIEW_CHANGED, expect.any(Object));
    reopened.dispose();
  });

  it('preserves unreadable state and refuses to replace it with a seed', async () => {
    state.mock = true;
    registerKosPreviewIpc();
    await command({ command: 'ready' });
    const file = path.join(state.userData, 'kos-preview', 'library.json');
    await writeFile(file, '{"version":2}');
    state.handlers.clear();
    registerKosPreviewIpc();
    await expect(command({ command: 'ready' })).rejects.toThrow();
    expect(await readFile(file, 'utf8')).toBe('{"version":2}');
  });
});
