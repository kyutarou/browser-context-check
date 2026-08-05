import { BrowserContextRegistry } from './registry-do';

export { BrowserContextRegistry };

export interface Env {
  REGISTRY: DurableObjectNamespace;
  /** Chrome extension origin allowed to POST snapshots, e.g. chrome-extension://abcdef... */
  EXTENSION_ORIGIN: string;
  /** Device this deployment serves. Single-tenant for now; see docs/DESIGN.md §9. */
  DEVICE_ID: string;
}

const BASE = '/browser-check/api/v1';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (!url.pathname.startsWith(BASE)) {
      return new Response('Not found', { status: 404 });
    }
    const route = url.pathname.slice(BASE.length) || '/';

    if (request.method === 'OPTIONS') return preflight(env);

    const stub = env.REGISTRY.get(env.REGISTRY.idFromName(env.DEVICE_ID));

    // Snapshot writes come from the extension. They are HMAC signed, so the CORS headers below
    // are a browser convenience and carry no authority.
    if (route === '/snapshot' && request.method === 'POST') {
      const forwarded = new Request(`https://do/?op=snapshot&signedPath=${encodeURIComponent('/snapshot')}`, {
        method: 'POST',
        headers: request.headers,
        body: await request.text(),
      });
      return withCors(await stub.fetch(forwarded), env);
    }

    if (route === '/pair' && request.method === 'POST') {
      const body = await request.json();
      const forwarded = new Request('https://do/?op=pair', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...(body as object), deviceId: env.DEVICE_ID }),
      });
      return withCors(await stub.fetch(forwarded), env);
    }

    // Reads are for the CLI. Access sits in front of this hostname, so there is no additional
    // credential check here — see docs/DESIGN.md §6.
    if (route === '/target' && request.method === 'GET') {
      const selector = url.searchParams.get('selector') ?? 'lastBrowser';
      return stub.fetch(`https://do/?op=target&selector=${encodeURIComponent(selector)}`);
    }

    if (route === '/pairing-code' && request.method === 'POST') {
      return stub.fetch('https://do/?op=issue-code');
    }

    if (route === '/revoke' && request.method === 'POST') {
      const forwarded = new Request('https://do/?op=revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: await request.text(),
      });
      return withCors(await stub.fetch(forwarded), env);
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
