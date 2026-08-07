// End-to-end exercise over real HTTP against `wrangler dev`.
//
// The unit tests reach the Durable Object directly and the router tests stub it out. This drives
// the whole path — Worker routing, prefix boundary, signature verification, Durable Object
// storage, resolver — the way the extension and the CLI actually use it.
//
//   pnpm --dir worker exec wrangler dev --port 8797 --local
//   node worker/scripts/e2e-local.mjs

const PORT = process.env.BCC_PORT || '8797';
const BASE = `http://127.0.0.1:${PORT}/browser-check`;
const CONSOLE_HEADERS = { 'x-bcc-console': '1' };

const enc = new TextEncoder();
const hex = (b) => Array.from(new Uint8Array(b)).map((x) => x.toString(16).padStart(2, '0')).join('');
const sha256Hex = async (t) => hex(await crypto.subtle.digest('SHA-256', enc.encode(t)));

async function signedSnapshot(secretHex, installationId, sequence, body) {
  const payload = JSON.stringify(body);
  const timestamp = Date.now().toString();
  const canonical = ['POST', '/snapshot', await sha256Hex(payload), timestamp, String(sequence)].join('\n');
  const key = await crypto.subtle.importKey(
    'raw', new Uint8Array(secretHex.match(/.{2}/g).map((h) => parseInt(h, 16))),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const signature = hex(await crypto.subtle.sign('HMAC', key, enc.encode(canonical)));
  return fetch(`${BASE}/ingest/v1/snapshot`, {
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

function snapshot(over) {
  const now = new Date().toISOString();
  return {
    deviceId: 'device-1', installationId: 'x', profileAlias: 'x', browserSessionId: 'sess-1',
    browserKind: 'chrome', engineVersion: '151.0.0.0', productVersion: '151.0.0.0',
    incognito: false, windowId: 11, tabId: 101, focusState: 'unfocused',
    url: 'https://example.com/docs', host: 'example.com', suppressed: null, title: null,
    lastInteractionAt: now, observedAt: now, eventId: crypto.randomUUID(), ...over,
  };
}

async function pair(alias, installationId = 'inst-' + alias) {
  const issued = await (await fetch(`${BASE}/api/v1/pairing-code`, { method: 'POST', headers: CONSOLE_HEADERS })).json();
  const { code } = JSON.parse(Buffer.from(issued.bundle, 'base64').toString('utf8'));
  const res = await fetch(`${BASE}/ingest/v1/pair`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code, installationId, profileAlias: alias }),
  });
  if (!res.ok) throw new Error(`pair ${alias} failed: ${res.status} ${await res.text()}`);
  return { installationId, ...(await res.json()) };
}

const target = async (selector) =>
  (await (await fetch(`${BASE}/api/v1/target?selector=${selector}`)).json());

const results = [];
const check = (name, ok, detail = '') => results.push({ name, ok, detail });

// --- pairing -----------------------------------------------------------------------------

const work = await pair('chrome-work');
const edge = await pair('edge-main');
check('pair two profiles', Boolean(work.relaySecret && edge.relaySecret));

const stale = await fetch(`${BASE}/ingest/v1/pair`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'AAAA-BBBB-CCCC', installationId: 'inst-x', profileAlias: 'x' }),
});
check('unknown pairing code rejected', stale.status === 403, `status=${stale.status}`);

// --- the Access boundary -----------------------------------------------------------------

for (const [op, method] of [['pairing-code', 'POST'], ['revoke', 'POST'], ['installations', 'GET'], ['target', 'GET']]) {
  const res = await fetch(`${BASE}/ingest/v1/${op}`, { method, body: method === 'POST' ? '{}' : undefined });
  check(`ingest prefix refuses ${op}`, res.status === 404, `status=${res.status}`);
}

const csrf = await fetch(`${BASE}/api/v1/revoke`, {
  method: 'POST', headers: { 'content-type': 'text/plain' },
  body: JSON.stringify({ installationId: work.installationId }),
});
check('cross-site shaped write refused', csrf.status === 403, `status=${csrf.status}`);

// --- signature ---------------------------------------------------------------------------

check('signed snapshot accepted',
  (await signedSnapshot(work.relaySecret, work.installationId, 1,
    snapshot({ browserSessionId: 's-work' }))).status === 200);

check('replayed sequence rejected',
  (await signedSnapshot(work.relaySecret, work.installationId, 1,
    snapshot({ browserSessionId: 's-work' }))).status === 403);

check('cross-installation secret rejected',
  (await signedSnapshot(edge.relaySecret, work.installationId, 2,
    snapshot({ browserSessionId: 's-work' }))).status === 403);

// --- resolution ---------------------------------------------------------------------------

await signedSnapshot(edge.relaySecret, edge.installationId, 1, snapshot({
  browserSessionId: 's-edge', browserKind: 'edge', tabId: 202, windowId: 22,
  // Sent now by the keepalive, but untouched for an hour.
  lastInteractionAt: new Date(Date.now() - 3_600_000).toISOString(),
}));

const last = await target('lastBrowser');
check('idle keepalive does not outrank the last-used browser',
  last.status === 'TARGET' && last.target.profileAlias === 'chrome-work',
  `${last.status} ${last.target?.profileAlias ?? ''}`);

const typo = await target('lastBrowsr');
check('misspelled selector refused, not silently defaulted',
  typo.status === 'NO_TARGET' && typo.reason === 'unknown_selector', JSON.stringify(typo));

const fg = await target('foreground');
check('foreground reports NO_TARGET when nothing has focus',
  fg.status === 'NO_TARGET' && fg.reason === 'no_focused_browser', JSON.stringify(fg));

const suppressed = await pair('chrome-newtab', 'inst-newtab');
await signedSnapshot(suppressed.relaySecret, suppressed.installationId, 1, snapshot({
  browserSessionId: 's-newtab', tabId: 303, windowId: 33,
  url: null, host: null, suppressed: 'blocked_scheme',
  lastInteractionAt: new Date(Date.now() - 7_200_000).toISOString(),
}));
const list = await (await fetch(`${BASE}/api/v1/installations`, { headers: CONSOLE_HEADERS })).json();
const newtabRow = list.installations.find((i) => i.profileAlias === 'chrome-newtab');
check('a withheld address still reports liveness',
  Boolean(newtabRow?.snapshot) && newtabRow.snapshot.url === null
    && newtabRow.snapshot.suppressed === 'blocked_scheme',
  JSON.stringify(newtabRow?.snapshot?.suppressed));

check('relay secret never reaches the console', !JSON.stringify(list).includes(work.relaySecret));

// --- AMBIGUOUS ------------------------------------------------------------------------------
// Two profiles touched at the same instant are genuinely indistinguishable. Answering with either
// one would send an agent to the wrong browser, so the resolver must decline.

const simultaneous = new Date().toISOString();
await signedSnapshot(work.relaySecret, work.installationId, 3,
  snapshot({ browserSessionId: 's-work', lastInteractionAt: simultaneous }));
await signedSnapshot(edge.relaySecret, edge.installationId, 2,
  snapshot({ browserSessionId: 's-edge', browserKind: 'edge', tabId: 202, windowId: 22,
    lastInteractionAt: simultaneous }));

const ambiguous = await target('lastBrowser');
check('two profiles used at the same instant report AMBIGUOUS',
  ambiguous.status === 'AMBIGUOUS' && ambiguous.candidates?.length === 2,
  `${ambiguous.status} candidates=${ambiguous.candidates?.length ?? 0}`);

check('AMBIGUOUS names both candidates',
  JSON.stringify((ambiguous.candidates ?? []).map((c) => c.profileAlias).sort())
    === JSON.stringify(['chrome-work', 'edge-main']),
  JSON.stringify((ambiguous.candidates ?? []).map((c) => c.profileAlias)));

// An explicit alias is never ambiguous: the caller already said which one they meant.
const byAlias = await target('alias:edge-main');
check('an explicit alias resolves even while lastBrowser is ambiguous',
  byAlias.status === 'TARGET' && byAlias.target.profileAlias === 'edge-main',
  `${byAlias.status} ${byAlias.target?.profileAlias ?? ''}`);

// Nudge one profile clear of the ambiguity window and the deadlock resolves.
//
// The wait is deliberate, not padding. Locally the round trips above take a couple of hundred
// milliseconds, which is inside the 750ms window — so "touched again just now" is still, correctly,
// too close to call. Clearing AMBIGUOUS requires a gap the resolver considers meaningful.
const AMBIGUITY_WINDOW_MS = 750;
await new Promise((r) => setTimeout(r, AMBIGUITY_WINDOW_MS + 350));
await signedSnapshot(work.relaySecret, work.installationId, 4,
  snapshot({ browserSessionId: 's-work', lastInteractionAt: new Date().toISOString() }));
const resolved = await target('lastBrowser');
check('AMBIGUOUS clears once one profile is clearly newer',
  resolved.status === 'TARGET' && resolved.target.profileAlias === 'chrome-work',
  `${resolved.status} ${resolved.target?.profileAlias ?? ''}`);

// --- report -----------------------------------------------------------------------------

let failed = 0;
for (const r of results) {
  if (!r.ok) failed++;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '  [' + r.detail + ']' : ''}`);
}
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
