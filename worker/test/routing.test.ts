import { describe, expect, it } from 'vitest';
import worker, { type Env } from '../src/index';

/**
 * The Access boundary is expressed as path prefixes: everything under /ingest/ is reachable
 * without SSO, everything else is not. These tests pin that boundary, because a privileged
 * operation leaking onto the ingest prefix would be reachable by anyone on the internet.
 */

interface Call {
  url: string;
  method: string;
}

function makeEnv(): { env: Env; calls: Call[] } {
  const calls: Call[] = [];
  const stub = {
    fetch: async (input: Request | string) => {
      const req = typeof input === 'string' ? new Request(input) : input;
      calls.push({ url: req.url, method: req.method });
      return new Response(JSON.stringify({ ok: true }), {
        headers: { 'content-type': 'application/json' },
      });
    },
  };
  const env = {
    REGISTRY: { idFromName: () => 'id', get: () => stub },
    EXTENSION_ORIGIN: 'chrome-extension://testid',
    DEVICE_ID: 'device-1',
    INGEST_ENDPOINT: 'https://dashboard.dxj.jp/browser-check/ingest/v1',
    ACCESS_CLIENT_ID: 'client-id-value',
    ACCESS_CLIENT_SECRET: 'client-secret-value',
  } as unknown as Env;
  return { env, calls };
}

const ORIGIN = 'https://dashboard.dxj.jp';

function opOf(calls: Call[]): string | null {
  if (calls.length === 0) return null;
  return new URL(calls[calls.length - 1].url).searchParams.get('op');
}

describe('ingest prefix (Access bypassed)', () => {
  it('accepts signed snapshot writes', async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/browser-check/ingest/v1/snapshot`, { method: 'POST', body: '{}' }),
      env,
    );
    expect(res.status).toBe(200);
    expect(opOf(calls)).toBe('snapshot');
  });

  it('accepts pairing redemption', async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/browser-check/ingest/v1/pair`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ code: 'X', installationId: 'i', profileAlias: 'a' }),
      }),
      env,
    );
    expect(res.status).toBe(200);
    expect(opOf(calls)).toBe('pair');
  });

  // The privileged operations must NOT be reachable without Access. Each of these would be an
  // internet-facing hole: minting pairing codes, unpairing a profile, or reading browsing context.
  it.each([
    ['/pairing-code', 'POST'],
    ['/revoke', 'POST'],
    ['/installations', 'GET'],
    ['/target', 'GET'],
  ])('refuses %s on the ingest prefix', async (op, method) => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/browser-check/ingest/v1${op}`, {
        method,
        body: method === 'POST' ? '{}' : undefined,
      }),
      env,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });

  it('does not let a path traversal segment climb out of the ingest prefix', async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/browser-check/ingest/v1/../api/v1/pairing-code`, { method: 'POST', body: '{}' }),
      env,
    );
    // URL normalisation resolves the traversal before routing; either way it must not mint a code.
    expect(opOf(calls)).not.toBe('issue-code');
    expect([404, 200]).toContain(res.status);
  });
});

describe('api prefix (behind Access)', () => {
  it('routes privileged operations through to the registry', async () => {
    for (const [path, method, expected] of [
      ['/pairing-code', 'POST', 'issue-code'],
      ['/installations', 'GET', 'installations'],
      ['/target', 'GET', 'target'],
      ['/revoke', 'POST', 'revoke'],
    ] as const) {
      const { env, calls } = makeEnv();
      const res = await worker.fetch(
        new Request(`${ORIGIN}/browser-check/api/v1${path}`, {
          method,
          body: method === 'POST' ? '{}' : undefined,
        }),
        env,
      );
      expect(res.status).toBe(200);
      expect(opOf(calls)).toBe(expected);
    }
  });

  it('mints a pairing bundle carrying the Access credentials', async () => {
    const { env, calls } = makeEnv();
    // The DO returns {ok:true} from the stub, so stand in a realistic issue-code reply.
    (env.REGISTRY as unknown as { get: () => { fetch: (u: string) => Promise<Response> } }).get =
      () => ({
        fetch: async (u: string) => {
          calls.push({ url: typeof u === 'string' ? u : (u as Request).url, method: 'GET' });
          return new Response(JSON.stringify({ code: 'AAAA-BBBB-CCCC', expiresInMs: 600000 }), {
            headers: { 'content-type': 'application/json' },
          });
        },
      });

    const res = await worker.fetch(
      new Request(`${ORIGIN}/browser-check/api/v1/pairing-code`, { method: 'POST' }),
      env,
    );
    expect(res.status).toBe(200);
    const { bundle } = (await res.json()) as { bundle: string };
    const decoded = JSON.parse(atob(bundle));
    expect(decoded).toMatchObject({
      code: 'AAAA-BBBB-CCCC',
      accessClientId: 'client-id-value',
      accessClientSecret: 'client-secret-value',
      endpoint: 'https://dashboard.dxj.jp/browser-check/ingest/v1',
    });
  });

  it('does not accept snapshot writes on the authenticated prefix', async () => {
    const { env, calls } = makeEnv();
    const res = await worker.fetch(
      new Request(`${ORIGIN}/browser-check/api/v1/snapshot`, { method: 'POST', body: '{}' }),
      env,
    );
    expect(res.status).toBe(404);
    expect(calls).toHaveLength(0);
  });
});

describe('console', () => {
  it('serves the html shell at the base path', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request(`${ORIGIN}/browser-check/`), env);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Browser Context Check');
    // Light is the default; a dark-mode OS setting must not flip it (design system policy).
    expect(body).toContain('data-theme="light"');
  });

  it('ignores unrelated paths on the same hostname', async () => {
    const { env } = makeEnv();
    const res = await worker.fetch(new Request(`${ORIGIN}/cashflow/`), env);
    expect(res.status).toBe(404);
  });
});
