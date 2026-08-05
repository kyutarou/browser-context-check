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

The whole hostname is behind Access, but the extension has no Access session — so exactly one
prefix bypasses it, and that prefix carries no privileged operation:

| prefix | caller | protection |
| --- | --- | --- |
| `/browser-check/` | human console | Access (SSO) |
| `/browser-check/api/v1/` | console + CLI | Access (SSO / service token) |
| `/browser-check/ingest/v1/` | extension only | Access bypass + HMAC signature |

The boundary is a prefix rather than a list of endpoints on purpose: a list eventually misses one,
and the miss fails open.

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

## Credits

The design was reviewed against primary Chromium/Chrome Web Store sources before implementation;
the reasoning is recorded in `docs/DESIGN.md`.

## License

MIT — see [LICENSE](LICENSE).
