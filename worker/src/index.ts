import { BrowserContextRegistry } from './registry-do';
import { CONSOLE_HTML } from './ui';

export { BrowserContextRegistry };

export interface Env {
  REGISTRY: DurableObjectNamespace;
  /** Chrome extension origin allowed to POST snapshots, e.g. chrome-extension://abcdef... */
  EXTENSION_ORIGIN: string;
  /** Device this deployment serves. Single-tenant for now; see docs/DESIGN.md §9. */
  DEVICE_ID: string;
  /** Public URL the extension posts to, handed to it inside the pairing bundle. */
  INGEST_ENDPOINT: string;
  /** Access service-token credentials carried across in the pairing bundle (secrets). */
  ACCESS_CLIENT_ID: string;
  ACCESS_CLIENT_SECRET: string;
}

const BASE = '/browser-check';

/**
 * Path layout, chosen so the Access boundary can be expressed as two prefixes rather than an
 * enumeration of endpoints — an enumeration eventually misses one, and the miss fails open.
 *
 *   /browser-check/            console  -> behind Access (human SSO)
 *   /browser-check/api/v1/...  console + CLI reads -> behind Access (SSO or service token)
 *   /browser-check/ingest/v1/… extension writes    -> Access Bypass, HMAC signed
 */
const API = `${BASE}/api/v1`;
const INGEST = `${BASE}/ingest/v1`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;

    if (!pathname.startsWith(BASE)) return new Response('Not found', { status: 404 });

    const stub = env.REGISTRY.get(env.REGISTRY.idFromName(env.DEVICE_ID));

    // ---- extension -> relay (Access bypassed; authenticated by HMAC in the Durable Object) ----

    if (pathname.startsWith(INGEST)) {
      if (request.method === 'OPTIONS') return preflight(env);

      const op = pathname.slice(INGEST.length);

      if (op === '/snapshot' && request.method === 'POST') {
        const forwarded = new Request(
          `https://do/?op=snapshot&signedPath=${encodeURIComponent('/snapshot')}`,
          { method: 'POST', headers: request.headers, body: await request.text() },
        );
        return withCors(await stub.fetch(forwarded), env);
      }

      if (op === '/pair' && request.method === 'POST') {
        const body = (await request.json()) as Record<string, unknown>;
        const forwarded = new Request('https://do/?op=pair', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...body, deviceId: env.DEVICE_ID }),
        });
        return withCors(await stub.fetch(forwarded), env);
      }

      return withCors(new Response('Not found', { status: 404 }), env);
    }

    // ---- console + CLI reads (Access in front of this hostname is the authentication) ----

    if (pathname.startsWith(API)) {
      const op = pathname.slice(API.length);

      if (op === '/target' && request.method === 'GET') {
        const selector = url.searchParams.get('selector') ?? 'lastBrowser';
        return stub.fetch(`https://do/?op=target&selector=${encodeURIComponent(selector)}`);
      }

      if (op === '/installations' && request.method === 'GET') {
        return stub.fetch('https://do/?op=installations');
      }

      // Issuing a pairing bundle is a privileged act, so it lives here rather than on the ingest
      // prefix: only an Access-authenticated human can mint one.
      //
      // The bundle carries the Access service-token credentials because a fresh installation has
      // no way to fetch them itself — the relay host is behind Access, which is the point. A
      // human moves them across once, and from then on the extension authenticates as a machine.
      if (op === '/pairing-code' && request.method === 'POST') {
        const issued = await stub.fetch('https://do/?op=issue-code');
        const { code, expiresInMs } = (await issued.json()) as { code: string; expiresInMs: number };
        const bundle = btoa(
          JSON.stringify({
            code,
            endpoint: env.INGEST_ENDPOINT,
            accessClientId: env.ACCESS_CLIENT_ID,
            accessClientSecret: env.ACCESS_CLIENT_SECRET,
          }),
        );
        return new Response(JSON.stringify({ bundle, expiresInMs }), {
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }

      if (op === '/revoke' && request.method === 'POST') {
        const forwarded = new Request('https://do/?op=revoke', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: await request.text(),
        });
        return stub.fetch(forwarded);
      }

      return new Response('Not found', { status: 404 });
    }

    // ---- console ----

    if ((pathname === BASE || pathname === `${BASE}/`) && request.method === 'GET') {
      return new Response(CONSOLE_HTML, {
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store',
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
        },
      });
    }

    return new Response('Not found', { status: 404 });
  },
};

function corsHeaders(env: Env): Record<string, string> {
  return {
    'Access-Control-Allow-Origin': env.EXTENSION_ORIGIN,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers':
      'content-type, x-bcc-installation, x-bcc-timestamp, x-bcc-sequence, x-bcc-signature',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  };
}

function preflight(env: Env): Response {
  return new Response(null, { status: 204, headers: corsHeaders(env) });
}

function withCors(response: Response, env: Env): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(corsHeaders(env))) headers.set(k, v);
  return new Response(response.body, { status: response.status, headers });
}
