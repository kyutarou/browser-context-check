// Target resolution. Pure logic, no I/O — this is the part that must not be wrong, so it is
// isolated from the Durable Object and tested directly.

export interface Snapshot {
  deviceId: string;
  installationId: string;
  profileAlias: string;
  browserSessionId: string;
  browserKind: string;
  engineVersion: string | null;
  productVersion: string | null;
  incognito: boolean;
  windowId: number;
  tabId: number;
  focusState: 'foreground' | 'unfocused';
  /** null when the active tab is one we refuse to disclose; the target itself is still valid. */
  url: string | null;
  host: string | null;
  /** Why the address was withheld, e.g. 'blocked_scheme'. null when the url is present. */
  suppressed: string | null;
  title: string | null;
  /**
   * When the user last actually did something in this browser: switched tab, loaded a page, or
   * focused a window. A heartbeat does NOT move it.
   *
   * Ranking by send time instead would make "the browser I was last looking at" mean "the browser
   * that most recently sent a keepalive", which is a different — and wrong — question.
   */
  lastInteractionAt: string;
  /** When the extension composed this snapshot. Client clock: untrusted, used only for display. */
  observedAt: string;
  /** When the relay accepted it. Server clock: this is what freshness is measured against. */
  receivedAt: string;
  eventId: string;
  sequence: number;
}

export type Selector =
  | { kind: 'lastBrowser' }
  | { kind: 'foreground' }
  | { kind: 'alias'; alias: string }
  | { kind: 'unknown'; raw: string };

export type Resolution =
  | { status: 'TARGET'; target: Snapshot; revision: string }
  | { status: 'NO_TARGET'; reason: string }
  | { status: 'STALE'; newestAgeMs: number; ttlMs: number }
  | { status: 'AMBIGUOUS'; candidates: Snapshot[] };

/**
 * Two snapshots are "too close to call" when their interaction times fall inside this window.
 * Events from different browsers and profiles do not arrive in one transaction, so a difference
 * of a few milliseconds carries no ordering information.
 */
export const AMBIGUITY_WINDOW_MS = 750;

export function parseSelector(raw: string | null): Selector {
  if (!raw || raw === 'lastBrowser') return { kind: 'lastBrowser' };
  if (raw === 'foreground') return { kind: 'foreground' };
  if (raw.startsWith('alias:')) return { kind: 'alias', alias: raw.slice('alias:'.length) };
  // Deliberately not a silent fall back to lastBrowser: a typo would then hand the caller a
  // different profile while looking like a success.
  return { kind: 'unknown', raw };
}

export function revisionOf(s: Snapshot): string {
  return [s.installationId, s.browserSessionId, s.windowId, s.tabId, s.sequence].join(':');
}

/** Freshness is measured on the server clock, so a skewed client cannot extend its own life. */
function ageMs(s: Snapshot, now: number): number {
  return now - Date.parse(s.receivedAt);
}

function interactionAt(s: Snapshot): number {
  const t = Date.parse(s.lastInteractionAt);
  return Number.isFinite(t) ? t : Date.parse(s.receivedAt);
}

/**
 * Picks the target for a selector.
 *
 * Deliberately does NOT fall back to "whichever arrived last" when several candidates are
 * indistinguishable: silently guessing here would send an agent to the wrong browser, which is
 * worse than telling the caller it cannot decide.
 */
export function resolve(
  snapshots: Snapshot[],
  selector: Selector,
  now: number,
  ttlMs: number,
): Resolution {
  if (selector.kind === 'unknown') return { status: 'NO_TARGET', reason: 'unknown_selector' };
  if (snapshots.length === 0) return { status: 'NO_TARGET', reason: 'no_snapshots' };

  const fresh = snapshots.filter((s) => {
    const age = ageMs(s, now);
    return Number.isFinite(age) && age >= 0 && age <= ttlMs;
  });

  if (fresh.length === 0) {
    const ages = snapshots.map((s) => ageMs(s, now)).filter((a) => Number.isFinite(a) && a >= 0);
    // Every timestamp was unusable (unparsable or in the future); treat as absent, not as fresh.
    if (ages.length === 0) return { status: 'NO_TARGET', reason: 'no_usable_timestamps' };
    return { status: 'STALE', newestAgeMs: Math.min(...ages), ttlMs };
  }

  let pool: Snapshot[];
  switch (selector.kind) {
    case 'alias':
      pool = fresh.filter((s) => s.profileAlias === selector.alias);
      if (pool.length === 0) return { status: 'NO_TARGET', reason: 'alias_not_found' };
      break;
    case 'foreground':
      pool = fresh.filter((s) => s.focusState === 'foreground');
      // Expected whenever the user has switched to a terminal — every browser reports unfocused.
      if (pool.length === 0) return { status: 'NO_TARGET', reason: 'no_focused_browser' };
      break;
    default:
      pool = fresh;
  }

  const sorted = [...pool].sort((a, b) => interactionAt(b) - interactionAt(a));
  const newest = sorted[0];
  const newestAt = interactionAt(newest);

  const contenders = sorted.filter((s) => newestAt - interactionAt(s) <= AMBIGUITY_WINDOW_MS);
  const distinct = new Set(contenders.map(revisionOf));

  if (distinct.size > 1) return { status: 'AMBIGUOUS', candidates: contenders };

  return { status: 'TARGET', target: newest, revision: revisionOf(newest) };
}
