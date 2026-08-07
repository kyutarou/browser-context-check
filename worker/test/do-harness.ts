// An in-memory DurableObjectState, faithful enough to run BrowserContextRegistry for real.
//
// The router tests replace the Durable Object with a stub that always answers 200, so a registry
// that rejected every pairing and every snapshot would still leave them green. This harness runs
// the actual class against actual storage.

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export interface Harness {
  state: DurableObjectState;
  store: Map<string, unknown>;
  /** Number of times blockConcurrencyWhile has been entered, to prove the guard is used. */
  blocks: number;
}

export function makeState(): Harness {
  const store = new Map<string, unknown>();
  let chain: Promise<unknown> = Promise.resolve();
  const harness = { store, blocks: 0 } as Harness;

  const storage = {
    async get<T>(key: string): Promise<T | undefined> {
      return store.get(key) as T | undefined;
    },
    async put(key: string, value: unknown): Promise<void> {
      store.set(key, value);
    },
    async delete(key: string | string[]): Promise<void> {
      for (const k of Array.isArray(key) ? key : [key]) store.delete(k);
    },
    async list<T>({ prefix }: { prefix: string }): Promise<Map<string, T>> {
      const out = new Map<string, T>();
      for (const [k, v] of store) if (k.startsWith(prefix)) out.set(k, v as T);
      return out;
    },
  };

  harness.state = {
    storage,
    // Serialises like the real thing: the callback runs to completion before anything else on
    // this object does.
    blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T> {
      harness.blocks++;
      const next = chain.then(fn, fn);
      chain = next.catch(() => undefined);
      return next as Promise<T>;
    },
  } as unknown as DurableObjectState;

  return harness;
}

export function req(op: string, body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`https://do/?op=${op}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Produces the exact signature the registry expects, so tests exercise the real check. */
export async function signHeaders(
  secretHex: string,
  installationId: string,
  sequence: number,
  bodyText: string,
  { timestamp = Date.now() }: { timestamp?: number } = {},
): Promise<Record<string, string>> {
  const bodyHash = toHex(await crypto.subtle.digest('SHA-256', encoder.encode(bodyText)));
  const canonical = ['POST', '/snapshot', bodyHash, String(timestamp), String(sequence)].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    new Uint8Array((secretHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16))),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  return {
    'content-type': 'application/json',
    'x-bcc-installation': installationId,
    'x-bcc-timestamp': String(timestamp),
    'x-bcc-sequence': String(sequence),
    'x-bcc-signature': toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical))),
  };
}

export function snapshotBody(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = new Date().toISOString();
  return {
    deviceId: 'device-1',
    installationId: 'ignored-by-server',
    profileAlias: 'ignored-by-server',
    browserSessionId: 'sess-1',
    browserKind: 'chrome',
    engineVersion: '151.0.0.0',
    productVersion: '151.0.0.0',
    incognito: false,
    windowId: 11,
    tabId: 101,
    focusState: 'unfocused',
    url: 'https://example.com/docs',
    host: 'example.com',
    suppressed: null,
    title: null,
    lastInteractionAt: now,
    observedAt: now,
    eventId: 'evt-1',
    ...over,
  };
}
