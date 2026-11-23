import { createWorkSyncLoop, syncWork } from '@cindy/maker-shared/work-sync';
import { activeOwnerScopeKey, getActiveDataOwnerPushStamp, isAppSessionBoundaryPending } from '../appSessionState';
import { activeSelfHostedRelay } from '../device-link/selfHostedRelayRouting';
import { tryGetDbClient } from '../localDb/client/current';
import { createLogger } from '../logger';

const log = createLogger('work-sync');
let notify: (() => void) | undefined;
let loop: ReturnType<typeof createWorkSyncLoop> | undefined;
export function configureWorkSyncNotification(listener: () => void) { notify = listener; }
export function wakeWorkSync() { loop?.wake(); }
export function startWorkSync(allowed: () => boolean) {
  loop?.stop();
  const instance = createWorkSyncLoop(async alive => {
    const db = tryGetDbClient(), owner = activeOwnerScopeKey(), stamp = getActiveDataOwnerPushStamp(), route = activeSelfHostedRelay();
    if (!db || !owner || !route || route.authMode !== 'none' || !allowed()) return false;
    const current = () => alive() && allowed() && !isAppSessionBoundaryPending() && db === tryGetDbClient() && owner === activeOwnerScopeKey()
      && stamp.ownerGeneration === getActiveDataOwnerPushStamp().ownerGeneration && route.baseUrl === activeSelfHostedRelay()?.baseUrl && route.relayId === activeSelfHostedRelay()?.relayId;
    try { return await syncWork({ scope: JSON.stringify([route.baseUrl, route.relayId]), current,
      replica: request => { if (!current()) return Promise.reject(new Error('WORK_CONTEXT_CHANGED')); return db.tx('umedaWork.replica', request); },
      changed: () => { if (current()) notify?.(); },
      async http(path, body) {
        const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 30_000);
        try {
          const response = await fetch(route.baseUrl + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: controller.signal });
          if (!current()) throw new Error('WORK_CONTEXT_CHANGED');
          const reader = response.body?.getReader(), parts: Uint8Array[] = []; let bytes = 0;
          if (reader) try { while (true) {
            const chunk = await reader.read(); if (chunk.done) break;
            bytes += chunk.value.byteLength;
            if (bytes > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('WORK_SYNC_REPLY_TOO_LARGE'); }
            parts.push(chunk.value);
          } } finally { reader.releaseLock(); }
          return { status: response.status, body: JSON.parse(Buffer.concat(parts).toString('utf8')) as unknown };
        } finally { clearTimeout(timeout); }
      },
    }); } catch (error) {
      if (current()) { await db.tx('umedaWork.replica', { operation: 'network', error: error instanceof Error ? error.message : '' }); notify?.(); }
      throw error;
    }
  }, () => { log.warn('work sync paused; local edits remain queued'); notify?.(); });
  loop = instance; instance.wake();
  return { stop() { instance.stop(); if (loop === instance) loop = undefined; } };
}
