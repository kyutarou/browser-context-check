// Stable identifiers for this extension instance.
//
// installationId lives in storage.local  -> survives browser restarts, dies on reinstall.
// browserSessionId lives in storage.session -> survives service worker suspension,
//                                              dies on browser restart. That is exactly the
//                                              lifetime we need to detect tabId reuse.

const INSTALLATION_KEY = 'installationId';
const SESSION_KEY = 'browserSessionId';

async function ensure(area, key) {
  const existing = await area.get(key);
  if (existing && existing[key]) return existing[key];
  const value = crypto.randomUUID();
  await area.set({ [key]: value });
  return value;
}

export async function getInstallationId() {
  return ensure(chrome.storage.local, INSTALLATION_KEY);
}

export async function getBrowserSessionId() {
  return ensure(chrome.storage.session, SESSION_KEY);
}

/**
 * The composite target reference. A bare tabId is not an identity: Chrome, Edge and other
 * profiles can hold the same numeric tabId at the same time, and the number is reused after
 * a restart.
 */
export function buildTargetRef({ deviceId, installationId, browserSessionId, incognito, windowId, tabId }) {
  return { deviceId, installationId, browserSessionId, incognito, windowId, tabId };
}
