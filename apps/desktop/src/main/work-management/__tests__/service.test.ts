import { beforeEach, describe, expect, it, vi } from 'vitest';
const state = vi.hoisted(() => ({
  owner: 'owner-a', stamp: { dataOwnerId: 'owner-a', ownerGeneration: 1 }, pending: false,
  route: { authMode: 'none', baseUrl: 'https://relay.invalid', relayId: 'fixture' },
  db: { tx: vi.fn(), queryOne: vi.fn() }, handlers: new Map<string, (...args: unknown[]) => unknown>(), trusted: true,
  send: vi.fn(), warn: vi.fn(),
}));
vi.mock('../../appSessionState', () => ({ activeOwnerScopeKey: () => state.owner, getActiveDataOwnerPushStamp: () => state.stamp, isAppSessionBoundaryPending: () => state.pending }));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => state.db, tryGetDbClient: () => state.db }));
vi.mock('../../device-link/selfHostedRelayRouting', () => ({ activeSelfHostedRelay: () => state.route }));
vi.mock('../../logger', () => ({ createLogger: () => ({ warn: state.warn }) }));
vi.mock('electron', () => ({ ipcMain: { handle: (name: string, fn: (...args: unknown[]) => unknown) => state.handlers.set(name, fn) }, BrowserWindow: { getAllWindows: () => [{ webContents: { send: state.send } }] } }));
vi.mock('../../security/trustedAppRenderer', () => ({ assertTrustedAppRendererEvent: () => { if (!state.trusted) throw new Error('untrusted'); }, isTrustedAppRendererWindow: () => true }));
import { executeWorkManagementRequest, setWorkManagementChangeListener } from '../service';
import { registerWorkManagementIpc } from '../ipc';
import { executeWorkManagement } from '../host';

// Value: production service + IPC registration must share human/Agent writes,
// fence stale owners and notify only views after commit. DB tests cannot cover
// Electron ingress or async owner changes. Minimal failure: old-owner reply after
// a switch; a committed write whose renderer notification fails. Tier: unit.
describe('work management host boundary', () => {
  beforeEach(() => {
    vi.clearAllMocks(); state.owner = 'owner-a'; state.pending = false; state.trusted = true;
    state.stamp = { dataOwnerId: 'owner-a', ownerGeneration: 1 }; state.handlers.clear();
    state.db.tx.mockResolvedValue({ items: [], status: 'local_saved' }); state.db.queryOne.mockResolvedValue({ cleared_at: 0 });
    registerWorkManagementIpc();
  });
  const create = { operation: 'create' as const, request_id: 'fixture-create', kind: 'task' as const, title: 'Read' };
  it('routes human and Agent operations through the same transaction and broadcasts owner-only invalidation', async () => {
    await state.handlers.get('umeda-work:execute')!({}, create, state.stamp);
    expect(state.db.tx).toHaveBeenLastCalledWith('umedaWork.execute', expect.objectContaining({ actor: { kind: 'user' }, request: create }));
    await executeWorkManagement({ sessionId: 'execution', agentKind: 'codex', workingDir: '/fixture' }, create);
    expect(state.db.tx).toHaveBeenLastCalledWith('umedaWork.execute', expect.objectContaining({ actor: { kind: 'agent_report', session_id: 'execution', epoch: 0, agent_kind: 'codex' } }));
    expect(state.send).toHaveBeenCalledWith('umeda-work:changed', state.stamp);
    state.send.mockClear();
    await executeWorkManagementRequest({ kind: 'user' }, { operation: 'list' });
    expect(state.send).not.toHaveBeenCalled();
  });
  it('rejects untrusted windows and stale renderer generations before reading or writing', async () => {
    const handler = state.handlers.get('umeda-work:execute')!;
    state.trusted = false;
    await expect(handler({}, create, state.stamp)).rejects.toThrow('untrusted');
    state.trusted = true;
    await expect(handler({}, create, { ...state.stamp, ownerGeneration: 0 })).rejects.toThrow('Work data owner changed');
    expect(state.db.tx).not.toHaveBeenCalled();
  });
  it('drops an old owner reply and never publishes its notification', async () => {
    let release!: (value: unknown) => void;
    state.db.tx.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const pending = executeWorkManagementRequest({ kind: 'user' }, create);
    state.owner = 'owner-b'; state.stamp = { dataOwnerId: 'owner-b', ownerGeneration: 2 };
    release({ items: [{ title: 'old owner' }] });
    await expect(pending).rejects.toThrow('WORK_CONTEXT_CHANGED');
    expect(state.send).not.toHaveBeenCalled();
  });
  it('preserves a committed receipt when a view cannot be notified, and returns typed conflicts', async () => {
    setWorkManagementChangeListener(() => { throw new Error('closed'); });
    await expect(executeWorkManagementRequest({ kind: 'user' }, create)).resolves.toMatchObject({ status: 'local_saved' });
    registerWorkManagementIpc();
    state.db.tx.mockResolvedValueOnce({ ok: false, errorCode: 'WORK_VERSION_CONFLICT' });
    await expect(state.handlers.get('umeda-work:execute')!({}, create, state.stamp)).rejects.toMatchObject({ code: 'WORK_VERSION_CONFLICT' });
  });
});
