// A minimal chrome extension API, enough to run background.js for real.
//
// The producer side is where the worst defect lived (a keepalive was allowed to look like user
// activity) and it had no tests at all, because "you need a browser" is an easy excuse. It does
// not hold: background.js only touches storage, tabs, windows, alarms and fetch, and all five are
// small enough to stand up here.

export function installChromeMock({ tab, focused = true, permissions = ['tabs'] } = {}) {
  const listeners = {
    tabsActivated: [],
    tabsUpdated: [],
    tabsRemoved: [],
    windowsFocusChanged: [],
    windowsRemoved: [],
    runtimeStartup: [],
    alarm: [],
  };

  const local = new Map();
  const session = new Map();
  const fetchCalls = [];
  let fetchResponse = { ok: true, status: 200, text: async () => '{"ok":true}' };

  const area = (map) => ({
    async get(keys) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const out = {};
      for (const k of wanted) if (map.has(k)) out[k] = map.get(k);
      return out;
    },
    async set(obj) {
      for (const [k, v] of Object.entries(obj)) map.set(k, v);
    },
    async remove(keys) {
      for (const k of (Array.isArray(keys) ? keys : [keys])) map.delete(k);
    },
  });

  const add = (bucket) => ({ addListener: (fn) => bucket.push(fn) });

  globalThis.chrome = {
    storage: { local: area(local), session: area(session) },
    permissions: {
      async contains({ permissions: wanted }) {
        return wanted.every((p) => permissions.includes(p));
      },
    },
    tabs: {
      async query() {
        return tab ? [tab] : [];
      },
      onActivated: add(listeners.tabsActivated),
      onUpdated: add(listeners.tabsUpdated),
      onRemoved: add(listeners.tabsRemoved),
    },
    windows: {
      WINDOW_ID_NONE: -1,
      async getLastFocused() {
        return { id: 1, focused };
      },
      onFocusChanged: add(listeners.windowsFocusChanged),
      onRemoved: add(listeners.windowsRemoved),
    },
    runtime: { onStartup: add(listeners.runtimeStartup) },
    alarms: { create() {}, onAlarm: add(listeners.alarm) },
  };

  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url, headers: init?.headers ?? {}, body: init?.body });
    return fetchResponse;
  };

  return {
    listeners,
    local,
    session,
    fetchCalls,
    setFocused(v) {
      focused = v;
    },
    setTab(v) {
      tab = v;
    },
    setFetchResponse(v) {
      fetchResponse = v;
    },
    /** Puts the extension in the state it reaches after a successful pairing. */
    arm() {
      local.set('agentMode', true);
      local.set('deviceId', 'device-1');
      local.set('profileAlias', 'chrome-work');
      local.set('relaySecret', 'aa'.repeat(32));
      local.set('accessClientId', 'client.access');
      local.set('accessClientSecret', 'secret');
      local.set('sequence', 0);
    },
    lastSnapshot() {
      const last = fetchCalls[fetchCalls.length - 1];
      return last ? JSON.parse(last.body) : null;
    },
  };
}

/**
 * Drains background.js's 250ms debounce plus the async work behind it.
 *
 * Generous on purpose: the first run in a process pays for WebCrypto key import, and a wait that
 * expires early does not fail the test it belongs to — it leaks the send into the NEXT test,
 * whose recorder then reports a call nobody made. That reads as a product bug and is not one.
 */
export const settle = () => new Promise((r) => setTimeout(r, 900));

/** Polls until the condition holds, so a slow first run costs time rather than correctness. */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 25 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return predicate();
}
