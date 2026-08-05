import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installChromeMock, settle, waitFor } from './chrome-mock.mjs';

const TAB = {
  id: 101,
  windowId: 11,
  incognito: false,
  url: 'https://example.com/docs?token=secret#frag',
  title: 'Docs',
};

/**
 * background.js registers its listeners at import time, so each test needs a fresh module
 * instance. resetModules clears the registry so the next import re-executes the top level.
 */
async function loadBackground() {
  vi.resetModules();
  await import('../../extension/background.js');
}

describe('background service worker', () => {
  let mock;

  beforeEach(() => {
    mock = installChromeMock({ tab: { ...TAB } });
  });

  // A send still in flight when the next test starts would be recorded against the next test's
  // mock, because background.js resolves globalThis.fetch at call time. Drain before moving on.
  afterEach(async () => {
    await settle();
  });

  // Positive control: if nothing ever sent, every "does not send" assertion below would pass
  // against a completely broken extension.
  it('sends a snapshot on tab activation once paired and armed', async () => {
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101, windowId: 11 }));
    await waitFor(() => mock.fetchCalls.length > 0);

    expect(mock.fetchCalls.length).toBeGreaterThan(0);
    const snap = mock.lastSnapshot();
    expect(snap.tabId).toBe(101);
    expect(snap.profileAlias).toBe('chrome-work');
    // Query and fragment must be gone by the time it leaves the browser.
    expect(snap.url).toBe('https://example.com/docs');
  });

  it('sends nothing at all before Agent Mode is switched on', async () => {
    // Paired, but the user has not opted in.
    mock.local.set('deviceId', 'device-1');
    mock.local.set('profileAlias', 'chrome-work');
    mock.local.set('relaySecret', 'aa'.repeat(32));
    mock.local.set('accessClientId', 'client.access');
    mock.local.set('accessClientSecret', 'secret');

    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    mock.listeners.alarm.forEach((fn) => fn({ name: 'heartbeat' }));
    await settle();

    expect(mock.fetchCalls).toHaveLength(0);
  });

  it('sends nothing without the Access credentials', async () => {
    mock.arm();
    mock.local.delete('accessClientSecret');
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await settle();
    expect(mock.fetchCalls).toHaveLength(0);
  });

  it('sends nothing when the tabs permission was declined', async () => {
    mock = installChromeMock({ tab: { ...TAB }, permissions: [] });
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await settle();
    expect(mock.fetchCalls).toHaveLength(0);
  });

  // The defect that made lastBrowser answer the wrong question.
  it('does not let the heartbeat advance lastInteractionAt', async () => {
    mock.arm();
    await loadBackground();

    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await waitFor(() => mock.fetchCalls.length >= 1);
    const afterInteraction = mock.lastSnapshot().lastInteractionAt;

    await new Promise((r) => setTimeout(r, 60));
    mock.listeners.alarm.forEach((fn) => fn({ name: 'heartbeat' }));
    await waitFor(() => mock.fetchCalls.length >= 2);
    const afterHeartbeat = mock.lastSnapshot();

    // The keepalive refreshes the snapshot but must not claim the user was here.
    expect(afterHeartbeat.lastInteractionAt).toBe(afterInteraction);
    expect(Date.parse(afterHeartbeat.observedAt)).toBeGreaterThan(Date.parse(afterInteraction));
  });

  it('advances lastInteractionAt when a window gains focus but not when it loses focus', async () => {
    mock.arm();
    await loadBackground();

    mock.listeners.windowsFocusChanged.forEach((fn) => fn(11));
    await waitFor(() => mock.fetchCalls.length >= 1);
    const gained = mock.lastSnapshot().lastInteractionAt;

    await new Promise((r) => setTimeout(r, 60));
    // -1 is WINDOW_ID_NONE: the user just switched to a terminal. That is precisely the moment
    // this browser must keep its claim to being the one last looked at.
    mock.listeners.windowsFocusChanged.forEach((fn) => fn(-1));
    await waitFor(() => mock.fetchCalls.length >= 2);

    expect(mock.lastSnapshot().lastInteractionAt).toBe(gained);
  });

  it('records a rejected push instead of treating it as success', async () => {
    mock.arm();
    mock.setFetchResponse({ ok: false, status: 403, text: async () => '{"error":"unknown_installation"}' });
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await waitFor(() => mock.local.has('lastPushStatus'));

    const status = mock.local.get('lastPushStatus');
    expect(status).toBeTruthy();
    expect(status.ok).toBe(false);
    expect(status.status).toBe(403);
  });

  it('records a successful push', async () => {
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await waitFor(() => mock.local.has('lastPushStatus'));

    expect(mock.local.get('lastPushStatus')).toMatchObject({ ok: true, status: 200 });
  });

  it('carries both the Access credentials and a signature on every write', async () => {
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await waitFor(() => mock.fetchCalls.length > 0);

    const { headers, url } = mock.fetchCalls[mock.fetchCalls.length - 1];
    expect(url).toContain('/ingest/v1/snapshot');
    expect(headers['CF-Access-Client-Id']).toBe('client.access');
    expect(headers['x-bcc-signature']).toMatch(/^[0-9a-f]{64}$/);
    expect(headers['x-bcc-sequence']).toBe('1');
  });

  it('never reports an incognito tab unless the user opted in', async () => {
    mock = installChromeMock({ tab: { ...TAB, incognito: true } });
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await settle();
    expect(mock.fetchCalls).toHaveLength(0);
  });

  it('never reports a browser-internal page', async () => {
    mock = installChromeMock({ tab: { ...TAB, url: 'chrome://settings' } });
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await settle();
    expect(mock.fetchCalls).toHaveLength(0);
  });
});
