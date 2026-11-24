interface RelayRequest {
  path: string;
  method?: 'GET' | 'PUT';
  body?: string;
  headers?: Record<string, string>;
}

const MAX_REPLY_BYTES = 4 * 1024 * 1024;

/** A captured, unauthenticated Umeda Vault route. The caller owns the writer lease. */
export function createKosRelayTransport(
  origin: string,
  ownsWriter: () => boolean,
  request: typeof fetch = fetch,
) {
  const relay = new URL(origin);
  if (relay.protocol !== 'https:' || relay.origin !== origin) throw new Error('KOS_INVALID_RELAY_ORIGIN');
  const operations = new Set<AbortController>();
  let stopped = false;

  const check = () => {
    if (stopped || !ownsWriter()) throw new Error('KOS_WRITER_LEASE_LOST');
  };

  return {
    origin,
    async call(input: RelayRequest) {
      check();
      const { path, method = 'GET', body, headers } = input;
      const url = new URL(path, origin);
      if (url.origin !== origin || url.hash || !/^\/api\/vaults(?:\/|$)/.test(url.pathname)
        || !['GET', 'PUT'].includes(method)) throw new Error('KOS_INVALID_RELAY_REQUEST');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 60_000);
      operations.add(controller);
      try {
        const response = await request(url, { method, body, headers, signal: controller.signal, redirect: 'error' });
        check();
        const reader = response.body?.getReader();
        const decoder = new TextDecoder();
        let text = '', bytes = 0;
        if (reader) {
          try {
            for (;;) {
              const chunk = await reader.read();
              check();
              if (chunk.done) break;
              bytes += chunk.value.byteLength;
              if (bytes > MAX_REPLY_BYTES) throw new Error('KOS_RELAY_REPLY_TOO_LARGE');
              text += decoder.decode(chunk.value, { stream: true });
            }
            text += decoder.decode();
          } finally {
            reader.releaseLock();
          }
        }
        return { status: response.status, body: text };
      } finally {
        clearTimeout(timer);
        operations.delete(controller);
        controller.abort();
      }
    },
    stop() {
      stopped = true;
      for (const operation of operations) operation.abort();
    },
  };
}

export type KosRelayTransport = ReturnType<typeof createKosRelayTransport>;
