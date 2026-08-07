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

  // The keepalive is the only thing keeping an idle browser's freshness alive, and it silently
  // did nothing: create() replaces an existing alarm and restarts its interval, while this file
  // re-runs on every service worker wake.
  it('does not restart the heartbeat interval on every service worker wake', async () => {
    mock.arm();
    await loadBackground();
    await waitFor(() => mock.alarms.has('heartbeat'));
    expect(mock.alarms.get('heartbeat').periodInMinutes).toBe(1);

    // Simulate the worker being evicted and woken again, repeatedly.
    await loadBackground();
    await loadBackground();
    await settle();

    expect(mock.alarms.get('heartbeat').createdCount).toBe(1);
  });

  describe('pairing handed over by the console', () => {
    const bundle = () =>
      btoa(
        JSON.stringify({
          code: 'AAAA-BBBB-CCCC',
          endpoint: 'https://dashboard.dxj.jp/browser-check/ingest/v1',
          accessClientId: 'client.access',
          accessClientSecret: 'secret',
        }),
      );

    const send = (message, sender) =>
      new Promise((resolve) => {
        mock.listeners.messageExternal.forEach((fn) => fn(message, sender, resolve));
      });

    // Positive control: the intended sender must actually get through.
    it('pairs when the console sends a valid bundle', async () => {
      mock.setFetchResponse({
        ok: true,
        status: 200,
        json: async () => ({ deviceId: 'device-1', relaySecret: 'bb'.repeat(32) }),
        text: async () => '',
      });
      await loadBackground();

      const reply = await send(
        { type: 'pair', bundle: bundle(), profileAlias: 'chrome-main' },
        { origin: 'https://dashboard.dxj.jp' },
      );
      expect(reply).toMatchObject({ ok: true, deviceId: 'device-1' });
      expect(mock.local.get('profileAlias')).toBe('chrome-main');
      // Pairing must not switch reporting on by itself.
      expect(mock.local.get('agentMode')).toBeUndefined();
    });

    it('refuses a bundle from any other origin', async () => {
      await loadBackground();
      const reply = await send(
        { type: 'pair', bundle: bundle(), profileAlias: 'chrome-main' },
        { origin: 'https://evil.example.com' },
      );
      expect(reply).toEqual({ ok: false, reason: 'unexpected_origin' });
      expect(mock.fetchCalls).toHaveLength(0);
      expect(mock.local.has('relaySecret')).toBe(false);
    });

    it('refuses a message it does not recognise', async () => {
      await loadBackground();
      const reply = await send({ type: 'something-else' }, { origin: 'https://dashboard.dxj.jp' });
      expect(reply).toEqual({ ok: false, reason: 'unknown_message' });
    });
  });

  it('never reports an incognito tab unless the user opted in', async () => {
    mock = installChromeMock({ tab: { ...TAB, incognito: true } });
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await settle();
    expect(mock.fetchCalls).toHaveLength(0);
  });

  it('withholds a browser-internal address but still reports liveness', async () => {
    // Dropping the whole snapshot here made a browser parked on a new tab look exactly like a
    // browser that had been closed — both went STALE — which is how this was found in production.
    mock = installChromeMock({ tab: { ...TAB, url: 'chrome://newtab/' } });
    mock.arm();
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await waitFor(() => mock.fetchCalls.length > 0);

    const snap = mock.lastSnapshot();
    expect(snap.url).toBeNull();
    expect(snap.host).toBeNull();
    expect(snap.suppressed).toBe('blocked_scheme');
    // Identity and liveness survive: the agent can still be told which tab this is.
    expect(snap.tabId).toBe(101);
    expect(snap.windowId).toBe(11);
  });

  it('withholds the title too when the address is withheld', async () => {
    mock = installChromeMock({ tab: { ...TAB, url: 'chrome://settings', title: 'Secret Settings' } });
    mock.arm();
    mock.local.set('sendTitle', true);
    await loadBackground();
    mock.listeners.tabsActivated.forEach((fn) => fn({ tabId: 101 }));
    await waitFor(() => mock.fetchCalls.length > 0);
    expect(mock.lastSnapshot().title).toBeNull();
  });
});
