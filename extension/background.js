// Service worker: observes tab/focus events and pushes a minimised snapshot to the relay.
//
// Nothing here runs until Agent Mode is enabled AND pairing has produced a secret.
// The extension ships inert.

import { pairWithBundle } from './lib/pair.js';
import { detectBrowser } from './lib/browser-kind.js';
import { getInstallationId, getBrowserSessionId } from './lib/ids.js';
import { redactUrl } from './lib/redact.js';
import { signedFetch } from './lib/relay.js';

/** @returns {{clientId: string, clientSecret: string} | null} */
async function getAccess() {
  const { accessClientId, accessClientSecret } = await chrome.storage.local.get([
    'accessClientId',
    'accessClientSecret',
  ]);
  if (!accessClientId || !accessClientSecret) return null;
  return { clientId: accessClientId, clientSecret: accessClientSecret };
}

const SETTINGS_DEFAULTS = {
  agentMode: false,
  sendTitle: false,
  includeIncognito: false,
  fullUrlAllowlist: [],
  // The ingest prefix has its own Access application authenticated by a service token. Nothing
  // bypasses Access; the console and read APIs sit behind SSO and are unreachable from here.
  endpoint: 'https://dashboard.dxj.jp/browser-check/ingest/v1',
};

// tabs.onActivated fires before the new tab's url/title have settled, so coalesce briefly.
const DEBOUNCE_MS = 250;
let pending = null;
let pendingIsInteraction = false;

const INTERACTION_KEY = 'lastInteractionAt';

/**
 * The moment the user last did something in THIS browser. The heartbeat must never move it:
 * if it did, an untouched browser would keep claiming to be the one most recently looked at,
 * and `lastBrowser` would resolve to whichever profile pinged last rather than the one the user
 * actually left.
 *
 * Kept in storage.session so it dies with the browser session, like browserSessionId.
 */
async function markInteraction() {
  await chrome.storage.session.set({ [INTERACTION_KEY]: new Date().toISOString() });
}

async function getLastInteractionAt() {
  const stored = await chrome.storage.session.get(INTERACTION_KEY);
  return stored[INTERACTION_KEY] || null;
}

async function getSettings() {
  const stored = await chrome.storage.local.get(Object.keys(SETTINGS_DEFAULTS));
  return { ...SETTINGS_DEFAULTS, ...stored };
}

async function getCredentials() {
  const { deviceId, profileAlias, relaySecret, sequence } = await chrome.storage.local.get([
    'deviceId',
    'profileAlias',
    'relaySecret',
    'sequence',
  ]);
  return { deviceId, profileAlias, relaySecret, sequence: sequence || 0 };
}

async function isArmed() {
  const settings = await getSettings();
  if (!settings.agentMode) return false;
  const creds = await getCredentials();
  if (!creds.relaySecret || !creds.deviceId || !creds.profileAlias) return false;
  // Without the Access credentials the relay host is unreachable, so there is nothing to arm.
  if (!(await getAccess())) return false;
  // tabs is optional; without it we cannot read url/title, so there is nothing worth sending.
  const granted = await chrome.permissions.contains({ permissions: ['tabs'] });
  return granted ? { settings, creds } : false;
}

async function currentFocusState() {
  // WINDOW_ID_NONE means no window of THIS browser has focus. That is the normal state once the
  // user switches to a terminal, which is exactly when the CLI runs — so an empty foreground
  // target is expected, not an error.
  try {
    const win = await chrome.windows.getLastFocused();
    return win && win.focused ? 'foreground' : 'unfocused';
  } catch {
    return 'unfocused';
  }
}

async function buildSnapshot(tab, settings, creds) {
  const [installationId, browserSessionId, browser, focusState, lastInteractionAt] =
    await Promise.all([
      getInstallationId(),
      getBrowserSessionId(),
      detectBrowser(),
      currentFocusState(),
      getLastInteractionAt(),
    ]);

  if (tab.incognito && !settings.includeIncognito) return null;

  const redacted = redactUrl(tab.url, { fullUrlAllowlist: settings.fullUrlAllowlist });
  if (!redacted.send) return null;

  const observedAt = new Date().toISOString();

  return {
    deviceId: creds.deviceId,
    installationId,
    profileAlias: creds.profileAlias,
    browserSessionId,
    browserKind: browser.browserKind,
    engineVersion: browser.engineVersion,
    productVersion: browser.productVersion,
    incognito: Boolean(tab.incognito),
    windowId: tab.windowId,
    tabId: tab.id,
    focusState,
    url: redacted.url,
    host: redacted.host,
    title: settings.sendTitle ? tab.title || null : null,
    // Falling back to now on a session with no recorded interaction yet would let a freshly
    // started background browser outrank the one the user is actually using.
    lastInteractionAt: lastInteractionAt || observedAt,
    observedAt,
    eventId: crypto.randomUUID(),
  };
}

async function push(snapshot, settings, creds) {
  // Advanced before sending, and left advanced on failure: reusing a sequence number would be
  // rejected as a replay anyway, and gaps are harmless because the relay only requires increase.
  const sequence = creds.sequence + 1;
  await chrome.storage.local.set({ sequence });

  let status;
  try {
    const res = await signedFetch({
      endpoint: settings.endpoint,
      path: '/snapshot',
      secretHex: creds.relaySecret,
      installationId: snapshot.installationId,
      sequence,
      body: snapshot,
      access: await getAccess(),
    });
    // fetch resolves for 403s and 500s alike. Without this check a revoked pairing, an expired
    // Access token or a rejected signature would look exactly like success, and the UI would go
    // on claiming Agent Mode was working while the relay heard nothing.
    status = res.ok
      ? { ok: true, status: res.status, at: new Date().toISOString() }
      : { ok: false, status: res.status, detail: (await res.text()).slice(0, 120), at: new Date().toISOString() };
  } catch (err) {
    status = { ok: false, status: 0, detail: String(err).slice(0, 120), at: new Date().toISOString() };
  }
  await chrome.storage.local.set({ lastPushStatus: status });
}

function schedule({ interaction = false } = {}) {
  if (interaction) pendingIsInteraction = true;
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    const wasInteraction = pendingIsInteraction;
    pendingIsInteraction = false;
    void (async () => {
      if (wasInteraction) await markInteraction();
      await report();
    })();
  }, DEBOUNCE_MS);
}

async function report() {
  const armed = await isArmed();
  if (!armed) return;
  const { settings, creds } = armed;

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  } catch {
    return;
  }
  if (!tab) return;

  const snapshot = await buildSnapshot(tab, settings, creds);
  if (!snapshot) return;
  await push(snapshot, settings, creds);
}

/**
 * Pairing handed over directly by the console, so nobody has to copy a base64 blob between two
 * windows — the step that goes wrong most often, and the one that puts the credentials on the
 * clipboard.
 *
 * The manifest restricts senders to the console's origin, and that origin sits behind Cloudflare
 * Access. The origin is re-checked here rather than trusted from the manifest alone.
 */
const CONSOLE_ORIGIN = 'https://dashboard.dxj.jp';

chrome.runtime.onMessageExternal.addListener((message, sender, sendResponse) => {
  if (sender.origin !== CONSOLE_ORIGIN) {
    sendResponse({ ok: false, reason: 'unexpected_origin' });
    return false;
  }
  if (!message || message.type !== 'pair') {
    sendResponse({ ok: false, reason: 'unknown_message' });
    return false;
  }

  // Agent Mode stays off: pairing grants no permission and starts no reporting. The user still
  // has to opt in, and Chrome still has to prompt for `tabs`.
  pairWithBundle(message.bundle, message.profileAlias).then(sendResponse);
  return true; // response is async
});

// Events the user causes: these move lastInteractionAt.
chrome.tabs.onActivated.addListener(() => schedule({ interaction: true }));
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) {
    schedule({ interaction: true });
  }
});
chrome.windows.onFocusChanged.addListener((windowId) => {
  // Losing focus is not an interaction — it is what happens when the user leaves for a terminal,
  // which is exactly the moment lastInteractionAt must stay put.
  schedule({ interaction: windowId !== chrome.windows.WINDOW_ID_NONE });
});

// State changes worth reporting, but not evidence that the user is here.
chrome.tabs.onRemoved.addListener(() => schedule());
chrome.windows.onRemoved.addListener(() => schedule());
chrome.runtime.onStartup.addListener(() => schedule());

// A service worker is evicted after ~30s idle, so the event listeners above are not enough to
// keep the relay's view fresh while the user reads a page. A slow alarm refreshes it — as a
// keepalive only; it must not make an idle browser look recently used.
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') schedule();
});
