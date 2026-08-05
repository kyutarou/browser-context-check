import { describe, expect, it } from 'vitest';
import { AMBIGUITY_WINDOW_MS, parseSelector, resolve, revisionOf, type Snapshot } from '../src/resolve';

const NOW = Date.parse('2026-08-05T12:00:00.000Z');
const TTL = 180_000;

function snap(over: Partial<Snapshot> = {}): Snapshot {
  return {
    deviceId: 'device-1',
    installationId: 'inst-chrome-work',
    profileAlias: 'chrome-work',
    browserSessionId: 'sess-1',
    browserKind: 'chrome',
    engineVersion: '150.0.0.0',
    productVersion: '150.0.0.0',
    incognito: false,
    windowId: 10,
    tabId: 100,
    focusState: 'unfocused',
    url: 'https://example.com/',
    host: 'example.com',
    title: null,
    observedAt: new Date(NOW - 1000).toISOString(),
    eventId: 'evt-1',
    receivedAt: new Date(NOW - 900).toISOString(),
    sequence: 1,
    ...over,
  };
}

describe('resolve', () => {
  it('returns NO_TARGET when nothing has been reported', () => {
    expect(resolve([], { kind: 'lastBrowser' }, NOW, TTL)).toEqual({
      status: 'NO_TARGET',
      reason: 'no_snapshots',
    });
  });

  // Positive control: the happy path must actually pass, otherwise a resolver that rejects
  // everything would satisfy the rest of this suite.
  it('returns TARGET for a single fresh snapshot', () => {
    const s = snap();
    const result = resolve([s], { kind: 'lastBrowser' }, NOW, TTL);
    expect(result.status).toBe('TARGET');
    if (result.status !== 'TARGET') return;
    expect(result.target.profileAlias).toBe('chrome-work');
    expect(result.revision).toBe(revisionOf(s));
  });

  it('returns STALE, not TARGET, once every snapshot is past its TTL', () => {
    const old = snap({ observedAt: new Date(NOW - TTL - 1).toISOString() });
    const result = resolve([old], { kind: 'lastBrowser' }, NOW, TTL);
    expect(result.status).toBe('STALE');
    if (result.status !== 'STALE') return;
    expect(result.newestAgeMs).toBeGreaterThan(TTL);
  });

  it('treats future timestamps as unusable rather than freshest', () => {
    const skewed = snap({ observedAt: new Date(NOW + 60_000).toISOString() });
    // A clock-skewed client must not be able to pin itself as permanently newest.
    expect(resolve([skewed], { kind: 'lastBrowser' }, NOW, TTL)).toEqual({
      status: 'NO_TARGET',
      reason: 'no_usable_timestamps',
    });
  });

  it('reports AMBIGUOUS instead of guessing when two profiles are indistinguishable', () => {
    const a = snap({ installationId: 'inst-a', profileAlias: 'chrome-work', tabId: 100 });
    const b = snap({
      installationId: 'inst-b',
      profileAlias: 'edge-main',
      tabId: 200,
      observedAt: new Date(NOW - 1000 - AMBIGUITY_WINDOW_MS + 10).toISOString(),
    });
    const result = resolve([a, b], { kind: 'lastBrowser' }, NOW, TTL);
    expect(result.status).toBe('AMBIGUOUS');
    if (result.status !== 'AMBIGUOUS') return;
    expect(result.candidates).toHaveLength(2);
  });

  it('picks the newer one when the gap is clearly outside the ambiguity window', () => {
    const older = snap({ installationId: 'inst-a', profileAlias: 'chrome-work' });
    const newer = snap({
      installationId: 'inst-b',
      profileAlias: 'edge-main',
      tabId: 200,
      observedAt: new Date(NOW - 100).toISOString(),
    });
    const result = resolve([older, newer], { kind: 'lastBrowser' }, NOW, TTL);
    expect(result.status).toBe('TARGET');
    if (result.status !== 'TARGET') return;
    expect(result.target.profileAlias).toBe('edge-main');
  });

  it('reports no focused browser rather than falling back to the last one', () => {
    // This is the normal state whenever the user has switched to a terminal to run the CLI.
    const result = resolve([snap({ focusState: 'unfocused' })], { kind: 'foreground' }, NOW, TTL);
    expect(result).toEqual({ status: 'NO_TARGET', reason: 'no_focused_browser' });
  });

  it('resolves a foreground selector when a browser really does hold focus', () => {
    const result = resolve([snap({ focusState: 'foreground' })], { kind: 'foreground' }, NOW, TTL);
    expect(result.status).toBe('TARGET');
  });

  it('selects by profile alias and rejects unknown aliases', () => {
    const pool = [
      snap({ installationId: 'inst-a', profileAlias: 'chrome-work' }),
      snap({ installationId: 'inst-b', profileAlias: 'edge-main', tabId: 200 }),
    ];
    const hit = resolve(pool, { kind: 'alias', alias: 'edge-main' }, NOW, TTL);
    expect(hit.status).toBe('TARGET');
    if (hit.status === 'TARGET') expect(hit.target.tabId).toBe(200);

    expect(resolve(pool, { kind: 'alias', alias: 'firefox-x' }, NOW, TTL)).toEqual({
      status: 'NO_TARGET',
      reason: 'alias_not_found',
    });
  });

  it('distinguishes identical tab ids coming from different browser sessions', () => {
    // tabId 100 exists in both; only the composite key tells them apart.
    const a = snap({ installationId: 'inst-a', browserSessionId: 'sess-a' });
    const b = snap({ installationId: 'inst-b', browserSessionId: 'sess-b', profileAlias: 'edge-main' });
    expect(revisionOf(a)).not.toBe(revisionOf(b));
  });
});

describe('parseSelector', () => {
  it('defaults to lastBrowser for absent or unrecognised values', () => {
    expect(parseSelector(null)).toEqual({ kind: 'lastBrowser' });
    expect(parseSelector('nonsense')).toEqual({ kind: 'lastBrowser' });
  });

  it('parses the supported selectors', () => {
    expect(parseSelector('foreground')).toEqual({ kind: 'foreground' });
    expect(parseSelector('alias:edge-main')).toEqual({ kind: 'alias', alias: 'edge-main' });
  });
});
