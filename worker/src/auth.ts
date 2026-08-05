// Request signing for the extension -> relay direction.
//
// CORS is not authentication, so every write is signed regardless of Origin.

const encoder = new TextEncoder();

export const REPLAY_WINDOW_MS = 120_000;

function toHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

function fromHex(hex: string): Uint8Array {
  const pairs = hex.match(/.{2}/g) ?? [];
  return new Uint8Array(pairs.map((h) => parseInt(h, 16)));
}

/** Constant-time comparison; a length-varying early return would leak the signature. */
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export interface VerifyInput {
  method: string;
  path: string;
  body: string;
  timestamp: string | null;
  sequence: string | null;
  signature: string | null;
  secretHex: string;
  lastSequence: number;
  now: number;
}

export type VerifyResult = { ok: true; sequence: number } | { ok: false; reason: string };

export async function verifySignature(input: VerifyInput): Promise<VerifyResult> {
  const { timestamp, sequence, signature } = input;
  if (!timestamp || !sequence || !signature) return { ok: false, reason: 'missing_auth_headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'bad_timestamp' };
  if (Math.abs(input.now - ts) > REPLAY_WINDOW_MS) return { ok: false, reason: 'timestamp_outside_window' };

  const seq = Number(sequence);
  if (!Number.isInteger(seq) || seq <= 0) return { ok: false, reason: 'bad_sequence' };
  if (seq <= input.lastSequence) return { ok: false, reason: 'sequence_replayed' };

  const canonical = [input.method, input.path, await sha256Hex(input.body), timestamp, sequence].join('\n');
  const key = await crypto.subtle.importKey(
    'raw',
    fromHex(input.secretHex),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const expected = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));

  if (!timingSafeEqual(expected, signature)) return { ok: false, reason: 'bad_signature' };
  return { ok: true, sequence: seq };
}

export function randomSecretHex(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(32)).buffer);
}
