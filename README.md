# Browser Context Check

A Chrome/Edge extension that lets a paired local AI agent work out **which browser, which profile,
and which tab** it should be targeting — without the human copying an id by hand.

Companion to [show-tab-id](https://github.com/kyutarou/show-tab-id). That extension stays as it is:
a manual viewer with no network access. This one is the agent-facing lane and ships separately.

## What this is not

It is **not** a way to drive the browser. A Chrome extension's `tabId` is a handle for
`chrome.tabs.*`; it is not a CDP/Playwright target id. Handing that number to a CLI does not let
the CLI touch the tab.

So this is a **beacon**, not a tab handle. It tells the agent *where to aim*. The agent still
operates the page through its own driver, using that driver's own target ids.

## How it works

```
extension (per profile)  --signed snapshot-->  Cloudflare Worker  <--GET--  local CLI agent
```

MV3 service workers cannot listen on a socket, so the extension pushes outward rather than
serving. The Worker keeps at most one snapshot per installation with a short TTL and answers
`TARGET` / `NO_TARGET` / `STALE` / `AMBIGUOUS`.

## Privacy posture

The extension **ships inert**. Nothing leaves the browser until you pair it and switch Agent Mode
on. Even then:

- query strings and fragments are stripped unless you allowlist a host
- `file://`, `chrome://`, `edge://`, `brave://` and extension pages are never reported
- page titles are a separate opt-in
- Incognito is excluded unless you opt in twice
- the relay keeps one record per profile, expiring in minutes

The `tabs` permission (warning: *"Read your browsing history"*) is **optional** and is requested
only when you enable Agent Mode.

## Identifiers

Chrome exposes no API for the profile directory name (`Default`, `Profile 2`), the profile path,
or the profile's display name — and an extension cannot read `chrome://version`. So profiles are
identified by a UUID stored in `storage.local` plus **a name you choose at pairing time**:

```
deviceId + installationId + profileAlias + browserSessionId + incognito + windowId + tabId
```

`tabId` alone is not an identity: Chrome, Edge and separate profiles can hold the same number
simultaneously, and numbers are reused after a restart.

## Selectors

Switching to a terminal makes every browser report `unfocused`, so "the tab with focus" is
routinely empty exactly when a CLI runs. Pick the selector that matches your situation:

| selector | meaning |
| --- | --- |
| `lastBrowser` *(default)* | the browser tab last looked at before focus left the browser |
| `foreground` | the tab holding OS focus right now — for fully autonomous runs |
| `alias:<name>` | a specific profile, e.g. `alias:edge-main` |

## Console

`https://dashboard.dxj.jp/browser-check/` is the human side: paired profiles and their freshness,
a live look at what each selector currently resolves to, pairing code issuance, and revocation.
It sits behind Cloudflare Access, so everything reachable from it is already authenticated.

Pairing codes are minted **here and nowhere else**. The extension-facing prefix cannot issue one.

## Access boundary

The whole hostname sits behind Cloudflare Access and the extension has no human SSO session — but
**nothing bypasses Access**. The ingest path gets its own Access application authenticated by a
service token, so the extension authenticates as a machine rather than through a hole:

| prefix | caller | protection |
| --- | --- | --- |
| `/browser-check/` | human console | Access (SSO) |
| `/browser-check/api/v1/` | console + CLI | Access (SSO / service token) |
| `/browser-check/ingest/v1/` | extension only | Access (Service Auth) + HMAC signature |

The boundary is a prefix rather than a list of endpoints on purpose: a list eventually misses one,
and the miss fails open.

The ingest token is bound to the ingest application alone, so a compromised extension still cannot
reach the console or the read API — verified: that request returns 401.

## Pairing

A freshly installed extension holds no Access credentials, so it cannot ask the relay for any —
that would be circular. The console emits a one-time bundle which the human carries across once:

```
{ code, endpoint, accessClientId, accessClientSecret }
```

Redeeming the code returns an installation-specific HMAC secret. From then on every write carries
both a service token and a signature.

There is no safe zero-setup path. One pairing step is required, once per profile.

## Tests

```bash
pnpm --dir worker test
```

Covers the resolver, HMAC verification, the routing/Access prefix boundary, the redaction module,
the Durable Object against real storage, and the extension's service worker driven through a
mocked chrome API. The last two matter: stub out the Durable Object and a registry that rejected
every pairing would still look green.

For the whole path over real HTTP, including AMBIGUOUS:

```bash
pnpm --dir worker exec wrangler dev --port 8797 --local
pnpm --dir worker e2e
```

## Usage

```bash
curl -s "https://dashboard.dxj.jp/browser-check/api/v1/target?selector=lastBrowser"
```

```json
{
  "status": "TARGET",
  "target": { "profileAlias": "chrome-work", "browserKind": "chrome", "tabId": 100, "...": "..." },
  "revision": "inst-abc:sess-1:10:100:42"
}
```

When two profiles are indistinguishable the answer is `AMBIGUOUS` with both candidates. It does
not guess — picking the one that arrived a millisecond later would send an agent to the wrong
browser.

## Layout

| path | contents |
| --- | --- |
| `extension/` | MV3 extension |
| `worker/` | Cloudflare Worker relay + Durable Object |
| `docs/DESIGN.md` | design baseline and invariants |

## Development

```bash
cd worker && npm install && npm test
```

Load the extension via `chrome://extensions` → Developer mode → Load unpacked → `extension/`.

**The `--load-extension` command-line flag will not work.** Chrome ignores it entirely on current
builds — verified on 150.0.7871.187, where the extension never appears in the profile's
`Secure Preferences` and its pages return `ERR_BLOCKED_BY_CLIENT`. That error names the extension
id, which makes it look like the extension loaded and was then blocked; it did not load at all.
Loading unpacked through the UI is the only path.

The extension id is pinned by the `key` in the manifest, so it is stable across machines and
reloads: `happeofpndgdgdjfcgjagobkjdaanjin`. The relay's CORS allowlist depends on that.

## Credits

The design was reviewed against primary Chromium/Chrome Web Store sources before implementation;
the reasoning is recorded in `docs/DESIGN.md`.

## License

MIT — see [LICENSE](LICENSE).
