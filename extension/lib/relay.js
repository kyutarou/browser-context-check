// Signed transport to the relay Worker.
//
// The shared secret is issued per installation during pairing and stored in storage.local.
// It is never baked into the extension bundle: this is open source, so anything shipped in the
// package is public.

const encoder = new TextEncoder();

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sha256Hex(text) {
  return toHex(await crypto.subtle.digest('SHA-256', encoder.encode(text)));
}

async function importKey(secretHex) {
  const bytes = new Uint8Array(secretHex.match(/.{2}/g).map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey('raw', bytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
}

/**
 * Signs method + path + body hash + timestamp + sequence. The server keeps a replay window and
 * rejects reused sequence numbers, so a captured request cannot be replayed.
 */
export async function signedFetch({ endpoint, path, secretHex, installationId, sequence, body }) {
  const payload = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const bodyHash = await sha256Hex(payload);
  const canonical = ['POST', path, bodyHash, timestamp, String(sequence)].join('\n');

  const key = await importKey(secretHex);
  const signature = toHex(await crypto.subtle.sign('HMAC', key, encoder.encode(canonical)));

  return fetch(endpoint + path, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-bcc-installation': installationId,
      'x-bcc-timestamp': timestamp,
      'x-bcc-sequence': String(sequence),
      'x-bcc-signature': signature,
    },
    body: payload,
  });
}
