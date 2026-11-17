import { randomBytes, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { PROTOCOL_VERSION } from '@cindy/device-link-protocol';
import { DEFAULT_HUB_LIMITS, Hub, type HubDevice } from '../src/hub';
import { DEVICE_ID_PATTERN, normalizeName } from '../src/stateModel';
import { RelayError } from '../src/errors';
import { RELAY_VERSION } from '../src/version';
import { DurableMedia } from './media';
import { DurableSocket } from './socket';
import { readJson } from './requestJson';
import type { EdgeSocket, ObjectContext } from './runtime';

const P = '/api/device-link';
const KEY = 'umeda-open-state-v1';
interface OpenState { relayId: string; name: string; mediaSigningKey: string; devices: HubDevice[] }
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
});

/** Public personal relay, explicitly selected by UMEDA_AUTH_MODE=none.
 * Device IDs are routing labels supplied by callers, never authentication.
 * The signed Node relay and its state remain separate and untouched.
 */
export class OpenRelay {
  private state!: OpenState;
  private readonly devices = new Map<string, HubDevice>();
  private readonly sockets = new Map<EdgeSocket, DurableSocket>();
  private hub!: Hub;
  private media!: DurableMedia;
  private readonly ready: Promise<void>;
  private revision = 1;
  private persistedRevision = 0;
  private writes: Promise<void> = Promise.resolve();

  constructor(private readonly ctx: ObjectContext) {
    this.ready = ctx.blockConcurrencyWhile(async () => {
      const stored = await ctx.storage.get<OpenState>(KEY);
      // Preserve names and device IDs when upgrading an already deployed relay.
      // No credential, certificate or owner key is copied into the public state.
      const old = stored ? undefined : await ctx.storage.get<OpenState>('relay-state');
      this.state = stored ?? {
        relayId: old?.relayId ?? randomUUID(), name: old?.name ?? 'Umeda',
        mediaSigningKey: old?.mediaSigningKey ?? randomBytes(32).toString('base64url'),
        devices: (old?.devices ?? []).map(d => ({
          deviceId: d.deviceId, reportedName: d.reportedName, customName: d.customName,
          role: d.role, platform: d.platform, appVersion: d.appVersion,
          deviceInfo: d.deviceInfo, pairedAt: d.pairedAt, lastSeenAt: d.lastSeenAt,
        })),
      };
      for (const device of this.state.devices) this.devices.set(device.deviceId, device);
      this.hub = new Hub({ get: id => this.devices.get(id), update: (id, patch) => {
        const device = this.devices.get(id);
        if (device) { Object.assign(device, patch); this.revision++; }
        return device;
      } }, 'local-v1', Date.now, { info() {}, warn() {}, error() {} }, { ...DEFAULT_HUB_LIMITS, hibernating: true });
      this.media = new DurableMedia(ctx.storage, this.state.mediaSigningKey);
      for (const socket of ctx.getWebSockets()) {
        const attachment = socket.deserializeAttachment();
        const device = attachment && this.devices.get(attachment.connection.deviceId);
        if (!device || socket.readyState !== 1) { socket.close(1001, 'reconnect'); continue; }
        const adapter = new DurableSocket(socket);
        this.sockets.set(socket, adapter);
        this.hub.attach(adapter, device, attachment!.connection);
      }
      await this.flush();
    });
  }

  private async flush(): Promise<void> {
    const write = this.writes.catch(() => undefined).then(async () => {
      if (this.revision === this.persistedRevision) return;
      const revision = this.revision;
      await this.ctx.storage.put(KEY, structuredClone({ ...this.state, devices: [...this.devices.values()] }));
      this.persistedRevision = revision;
    });
    this.writes = write;
    await write;
  }

  async fetch(request: Request): Promise<Response> {
    await this.ready;
    try {
      const response = await this.handle(request);
      await this.flush();
      await this.scheduleAlarm();
      return response;
    } catch (error) {
      const failure = error instanceof RelayError ? error : new RelayError('INTERNAL', 'internal relay error');
      return json({ error: { code: failure.code, message: failure.message } }, failure.status);
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url), route = url.pathname, method = request.method;
    const version = `${RELAY_VERSION}-umeda.2`;
    if (method === 'GET' && ['/', '/health'].includes(route)) return json({
      service: 'umeda-relay', version, initialized: true, protocolVersion: PROTOCOL_VERSION, authMode: 'none',
    });
    if (route.startsWith(`${P}/relay/blob/`)) return this.media.handle(request);
    if (method === 'GET' && route === `${P}/relay/info`) return json({
      relayId: this.state.relayId, name: this.state.name, protocolVersion: PROTOCOL_VERSION,
      relayVersion: version, authMode: 'none', features: [],
    });
    const selfId = request.headers.get('x-umeda-device-id') ?? url.searchParams.get('deviceId') ?? '';
    if (method === 'GET' && route === `${P}/ws`) {
      if (request.headers.get('upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket upgrade required', { status: 426 });
      if (!DEVICE_ID_PATTERN.test(selfId)) throw new RelayError('BAD_REQUEST', 'deviceId routing label required');
      if (this.ctx.getWebSockets().length >= DEFAULT_HUB_LIMITS.maxConnections) throw new RelayError('RATE_LIMITED', 'relay connection limit reached');
      let device = this.devices.get(selfId);
      if (!device) {
        if (this.devices.size >= DEFAULT_HUB_LIMITS.maxConnections) throw new RelayError('RATE_LIMITED', 'relay device capacity reached');
        device = { deviceId: selfId, role: 'member', reportedName: selfId, customName: null,
          platform: null, appVersion: null, deviceInfo: null, pairedAt: Date.now(), lastSeenAt: null };
        this.devices.set(selfId, device);
        this.revision++;
      }
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      const adapter = new DurableSocket(pair[1]);
      this.sockets.set(pair[1], adapter);
      this.hub.attach(adapter, device);
      return new Response(null, { status: 101, webSocket: pair[0] } as ResponseInit);
    }
    if (method === 'GET' && route === `${P}/devices`) return json({ devices: [...this.devices.values()].map(d => this.hub.deviceView(d, selfId)) });
    const match = /^\/api\/device-link\/devices\/([^/]+)$/.exec(route);
    if (match && ['PATCH', 'DELETE'].includes(method)) {
      const id = decodeURIComponent(match[1]), device = this.devices.get(id);
      if (!device) throw new RelayError('NOT_FOUND', 'device not found');
      if (method === 'DELETE') {
        this.devices.delete(id); this.revision++; this.hub.disconnectDevice(device, 4410, 'device removed');
        return json({ deleted: true });
      }
      const name = normalizeName((await readJson(request)).name);
      if (!name) throw new RelayError('BAD_REQUEST', 'invalid device name');
      device.customName = name; this.revision++; this.hub.announce(device);
      return json({ device: this.hub.deviceView(device, selfId) });
    }
    if (method === 'POST' && route === `${P}/media/presign-put`) return json(await this.media.presignPut(await readJson(request), url.origin));
    if (method === 'POST' && route === `${P}/media/presign-get`) return json(await this.media.presignGet((await readJson(request)).key, url.origin));
    if (method === 'DELETE' && route === `${P}/media`) { await this.media.delete((await readJson(request)).key); return json({ deleted: true }); }
    if (route === `${P}/push-token` && ['PUT', 'DELETE'].includes(method)) return new Response(null, { status: 204 });
    if (method === 'GET' && route === `${P}/provider-shares`) return json({ shares: [] });
    throw new RelayError('NOT_FOUND', 'route is not available on this relay');
  }

  async webSocketMessage(socket: EdgeSocket, message: string | ArrayBuffer): Promise<void> {
    await this.ready;
    const deviceId = socket.deserializeAttachment()?.connection.deviceId;
    if (!deviceId || !this.devices.has(deviceId)) { socket.close(4410, 'device removed'); return; }
    this.sockets.get(socket)?.emit('message', typeof message === 'string' ? Buffer.from(message) : Buffer.from(message), typeof message !== 'string');
    await this.flush(); await this.scheduleAlarm();
  }
  async webSocketClose(socket: EdgeSocket): Promise<void> {
    await this.ready;
    this.sockets.get(socket)?.emit('close'); this.sockets.delete(socket);
    await this.flush(); await this.scheduleAlarm();
  }
  async alarm(): Promise<void> {
    await this.ready;
    this.hub.closeIdle(); await this.media.sweep(); await this.flush(); await this.scheduleAlarm();
  }
  private async scheduleAlarm(): Promise<void> {
    const next = Math.max(Date.now() + 1_000, Math.min(this.hub.nextDeadline() ?? Infinity, Date.now() + 3_600_000));
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > next || current <= Date.now()) await this.ctx.storage.setAlarm(next);
  }
}
