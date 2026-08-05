import { describe, expect, it } from 'vitest';
import { randomSecretHex, verifySignature } from '../src/auth';

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sign(secretHex: string, canonical: string): Promise<string> {
  const bytes = new Uint8Array((secretHex.match(/.{2}/g) ?? []).map((h) => parseInt(h, 16)));
  const key = await crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

const SECRET = randomSecretHex();
const NOW = 1_785_900_000_000;
const BODY = JSON.stringify({ tabId: 100 });

async function makeRequest(over: Partial<Parameters<typeof verifySignature>[0]> = {}) {
  const timestamp = String(NOW);
  const sequence = '5';
  const canonical = ['POST', '/snapshot', await sha256Hex(BODY), timestamp, sequence].join('\n');
  return {
    method: 'POST',
    path: '/snapshot',
    body: BODY,
    timestamp,
    sequence,
    signature: await sign(SECRET, canonical),
    secretHex: SECRET,
    lastSequence: 4,
    now: NOW,
    ...over,
  };
}

describe('verifySignature', () => {
  // Positive control: without this, a verifier that rejects everything would pass the suite.
  it('accepts a correctly signed request', async () => {
    expect(await verifySignature(await makeRequest())).toEqual({ ok: true, sequence: 5 });
  });

  it('rejects a tampered body even when the signature is well formed', async () => {
    const req = await makeRequest({ body: JSON.stringify({ tabId: 999 }) });
    expect(await verifySignature(req)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a replayed sequence number', async () => {
    const req = await makeRequest({ lastSequence: 5 });
    expect(await verifySignature(req)).toEqual({ ok: false, reason: 'sequence_replayed' });
  });

  it('rejects a request signed for a different path', async () => {
    const req = await makeRequest({ path: '/revoke' });
    expect(await verifySignature(req)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects a stale timestamp outside the replay window', async () => {
    const req = await makeRequest({ now: NOW + 300_000 });
    expect(await verifySignature(req)).toEqual({ ok: false, reason: 'timestamp_outside_window' });
  });

  it('rejects a request signed with a different installation secret', async () => {
    const req = await makeRequest({ secretHex: randomSecretHex() });
    expect(await verifySignature(req)).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('rejects requests missing auth headers entirely', async () => {
    const req = await makeRequest({ signature: null });
    expect(await verifySignature(req)).toEqual({ ok: false, reason: 'missing_auth_headers' });
  });
});

describe('randomSecretHex', () => {
  it('produces distinct 256-bit secrets', () => {
    const a = randomSecretHex();
    const b = randomSecretHex();
    expect(a).toHaveLength(64);
    expect(a).not.toBe(b);
  });
});
