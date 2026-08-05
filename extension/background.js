// Service worker: observes tab/focus events and pushes a minimised snapshot to the relay.
//
// Nothing here runs until Agent Mode is enabled AND pairing has produced a secret.
// The extension ships inert.

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
  // The ingest prefix is the only part of the host that bypasses Cloudflare Access; the console
  // and read APIs sit behind SSO and are not reachable from here.
  endpoint: 'https://dashboard.dxj.jp/browser-check/ingest/v1',
};

// tabs.onActivated fires before the new tab's url/title have settled, so coalesce briefly.
const DEBOUNCE_MS = 250;
let pending = null;

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
  const [installationId, browserSessionId, browser, focusState] = await Promise.all([
    getInstallationId(),
    getBrowserSessionId(),
    detectBrowser(),
    currentFocusState(),
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
    observedAt,
    eventId: crypto.randomUUID(),
  };
}

async function push(snapshot, settings, creds) {
  const sequence = creds.sequence + 1;
  await chrome.storage.local.set({ sequence });
  try {
    await signedFetch({
      endpoint: settings.endpoint,
      path: '/snapshot',
      secretHex: creds.relaySecret,
      installationId: snapshot.installationId,
      sequence,
      body: snapshot,
      access: await getAccess(),
    });
  } catch {
    // The relay being unreachable is not an error worth surfacing: the CLI will simply see a
    // STALE or NO_TARGET response, which is the correct fail-closed outcome.
  }
}

function schedule() {
  if (pending) clearTimeout(pending);
  pending = setTimeout(() => {
    pending = null;
    void report();
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

chrome.tabs.onActivated.addListener(schedule);
chrome.tabs.onUpdated.addListener((_tabId, changeInfo) => {
  if (changeInfo.status === 'complete' || changeInfo.url || changeInfo.title) schedule();
});
chrome.tabs.onRemoved.addListener(schedule);
chrome.windows.onFocusChanged.addListener(schedule);
chrome.windows.onRemoved.addListener(schedule);
chrome.runtime.onStartup.addListener(schedule);

// A service worker is evicted after ~30s idle, so the event listeners above are not enough to
// keep the relay's view fresh while the user reads a page. A slow alarm refreshes it.
chrome.alarms.create('heartbeat', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') schedule();
});
