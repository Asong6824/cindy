/**
 * Value: exercise production UmedaRelay.fetch/WS callbacks with in-memory platform ports.
 * Gap: Node HTTP tests cannot simulate DO eviction, durable pairing or pinned bootstrap.
 * Minimal failures: stolen public bootstrap with a changed credential hash; eviction while a
 * join awaits approval; a revoked socket delivering a queued frame. Tier: unit, no real waits.
 */
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createRelaySigningKey, issueRelayDeviceCert, signRelayInitialization, createRelayPairSecret, computeRelayPairProof, type RelayInitialization } from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import { createDeviceCredential, hashSecret } from '../../src/credentials';
import { UmedaRelay } from '../worker';
import type { EdgeSocket, ObjectContext, ObjectStorage, RelayEnvironment, SocketAttachment } from '../runtime';

class MemoryStorage implements ObjectStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string) { return structuredClone(this.values.get(key)) as T | undefined; }
  async put<T>(key: string, value: T) { this.values.set(key, structuredClone(value)); }
  async delete(keys: string | string[]) { for (const key of typeof keys === 'string' ? [keys] : keys) this.values.delete(key); }
  async list<T>({ prefix }: { prefix: string }) {
    return new Map([...this.values].filter(([key]) => key.startsWith(prefix)).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, structuredClone(v) as T]));
  }
  async getAlarm() { return this.alarm; }
  async setAlarm(at: number) { this.alarm = at; }
  async deleteAlarm() { this.alarm = null; }
}
class Socket implements EdgeSocket {
  readyState = 1;
  sent: Array<Record<string, any>> = [];
  closed: number | null = null;
  constructor(private attachment: SocketAttachment) {}
  send(value: string | ArrayBuffer) { this.sent.push(JSON.parse(String(value))); }
  close(code: number) { this.closed = code; this.readyState = 3; }
  serializeAttachment(value: SocketAttachment) { this.attachment = structuredClone(value); }
  deserializeAttachment() { return structuredClone(this.attachment); }
}
function setup() {
  const storage = new MemoryStorage();
  const sockets: EdgeSocket[] = [];
  const ctx: ObjectContext = { storage, getWebSockets: () => sockets,
    acceptWebSocket: socket => { sockets.push(socket); }, blockConcurrencyWhile: async fn => fn(), waitUntil() {} };
  const key = createRelaySigningKey(crypto);
  const owner = createDeviceCredential();
  const relayId = randomUUID();
  const init: RelayInitialization = { relayId, name: 'Test relay', ownerDeviceId: 'desktop', ownerDeviceName: 'Test computer',
    ownerUserId: 'local-v1', ownerCredentialHash: owner.credentialHash, ownerPublicKey: key.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, key.seed, { relayId, deviceId: 'desktop', publicKey: key.publicKey, role: 'owner', issuedAt: 1 }) };
  const env = { UMEDA_OWNER_PUBLIC_KEY: key.publicKey } as RelayEnvironment;
  let worker = new UmedaRelay(ctx, env);
  const call = (path: string, method = 'GET', body?: unknown, credential?: string, headers?: Record<string, string>) => worker.fetch(new Request(`https://relay.invalid${path}`, {
    method, headers: { ...(body ? { 'content-type': 'application/json' } : {}), ...(credential ? { authorization: `CindyRelay ${credential}` } : {}), ...headers },
    ...(body ? { body: JSON.stringify(body) } : {}),
  }));
  return { storage, sockets, key, owner, init, call,
    raw: (request: Request) => worker.fetch(request),
    initialize: () => call('/api/device-link/relay/initialize', 'POST', { ...init, proof: signRelayInitialization(crypto, key.seed, init) }),
    restore() { worker = new UmedaRelay(ctx, env); },
    message: (socket: EdgeSocket, message: unknown) => worker.webSocketMessage(socket, JSON.stringify(message)),
  };
}
const P = '/api/device-link';
async function join(h: ReturnType<typeof setup>, approve = true) {
  const { code } = await (await h.call(`${P}/relay/admin/join-codes`, 'POST', {}, h.owner.credential)).json() as any;
  const key = createRelaySigningKey(crypto);
  const body = { code, deviceId: 'phone', deviceName: 'Test phone', accountUserId: 'local-v1', publicKey: key.publicKey,
    proof: computeRelayPairProof(crypto, createRelayPairSecret(crypto), { relayId: h.init.relayId, deviceId: 'phone', publicKey: key.publicKey }) };
  const request = await (await h.call(`${P}/relay/pair`, 'POST', body)).json() as any;
  if (approve) await h.call(`${P}/relay/admin/pair-requests/${request.requestId}/approve`, 'POST', {
    cert: issueRelayDeviceCert(crypto, h.key.seed, { relayId: h.init.relayId, deviceId: 'phone', publicKey: key.publicKey, role: 'member', issuedAt: 2 }),
  }, h.owner.credential);
  return { key, request, poll: () => h.call(`${P}/relay/pair/${request.requestId}?wait=0`, 'GET', undefined, undefined, { 'x-cindy-relay-poll-token': request.pollToken }) };
}
function socket(deviceId: string, credential: string) {
  return new Socket({ credentialHash: hashSecret(credential), connection: { deviceId, ready: true, remoteControlEnabled: false,
    busy: false, lastInboundAt: Date.now(), helloDeadlineAt: Date.now() + 15_000 } });
}
describe('Workers relay public contract', () => {
  it('pins the owner and signs the entire bootstrap, including the credential hash', async () => {
    const h = setup();
    const proof = signRelayInitialization(crypto, h.key.seed, h.init);
    expect((await h.call(`${P}/relay/initialize`, 'POST', { ...h.init, ownerCredentialHash: 'a'.repeat(64), proof })).status).toBe(403);
    expect((await h.initialize()).status).toBe(201);
    h.restore();
    expect((await h.initialize()).status).toBe(200);
    const replacement = { ...h.init, ownerCredentialHash: 'b'.repeat(64) };
    expect((await h.call(`${P}/relay/initialize`, 'POST', { ...replacement, proof: signRelayInitialization(crypto, h.key.seed, replacement) })).status).toBe(409);
    expect((await h.call(`${P}/devices`, 'GET', undefined, h.owner.credential)).status).toBe(200);
    expect((await h.call(`${P}/devices`, 'GET', undefined, 'invalid-credential')).status).toBe(401);
  });
  it('persists approval across eviction and releases a member credential exactly once', async () => {
    const h = setup(); await h.initialize();
    const member = await join(h);
    h.restore();
    const result = await (await member.poll()).json() as any;
    expect(result.status).toBe('approved');
    h.restore();
    expect((await (await member.poll()).json() as any).status).toBe('expired');
    expect((await h.call(`${P}/devices`, 'GET', undefined, result.credential)).status).toBe(200);
    expect((await h.call(`${P}/relay/admin/join-codes`, 'POST', {}, result.credential)).status).toBe(403);
  });
  it('restores sockets, respects remote-control settings and fences queued frames after revocation', async () => {
    const h = setup(); await h.initialize();
    const member = await join(h);
    const { credential } = await (await member.poll()).json() as any;
    const host = socket('desktop', h.owner.credential), phone = socket('phone', credential);
    h.sockets.push(host, phone); h.restore();
    await h.message(phone, { v: 1, kind: 'link-open', id: 'one', src: 'forged', dst: 'desktop' });
    expect(phone.sent.at(-1)?.payload.code).toBe('REMOTE_DISABLED');
    await h.message(host, { v: 1, kind: 'presence-set', payload: { remoteControlEnabled: true } });
    await h.message(phone, { v: 1, kind: 'link-open', id: 'two', src: 'forged', dst: 'desktop' });
    expect(host.sent.at(-1)).toMatchObject({ src: 'phone', id: 'two' });
    await h.call(`${P}/devices/phone`, 'DELETE', undefined, h.owner.credential);
    const sent = host.sent.length;
    await h.message(phone, { v: 1, kind: 'link-open', id: 'three', dst: 'desktop' });
    expect(host.sent).toHaveLength(sent);
    expect(phone.closed).toBe(4410);
  });
  it('keeps signed attachment URLs and byte ranges usable after eviction', async () => {
    const h = setup(); await h.initialize();
    const ticket = await (await h.call(`${P}/media/presign-put`, 'POST', { size: 5, ext: 'txt', contentType: 'text/plain' }, h.owner.credential)).json() as any;
    h.restore();
    expect((await h.raw(new Request(ticket.putUrl, { method: 'PUT', body: 'hello' }))).status).toBe(200);
    h.restore();
    const { getUrl } = await (await h.call(`${P}/media/presign-get`, 'POST', { key: ticket.key }, h.owner.credential)).json() as any;
    const range = await h.raw(new Request(getUrl, { headers: { range: 'bytes=1-3' } }));
    expect(range.status).toBe(206);
    expect(range.headers.get('content-range')).toBe('bytes 1-3/5');
    expect(await range.text()).toBe('ell');
    expect((await h.raw(new Request(ticket.putUrl, { method: 'PUT', body: 'again' }))).status).toBe(409);
    const second = await (await h.call(`${P}/media/presign-put`, 'POST', { size: 9 * 1024 * 1024, ext: 'bin', contentType: 'application/octet-stream' }, h.owner.credential)).json() as any;
    expect(second.error.code).toBe('PAYLOAD_TOO_LARGE');
  });
});
