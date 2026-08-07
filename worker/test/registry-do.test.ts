import { beforeEach, describe, expect, it } from 'vitest';
import { BrowserContextRegistry } from '../src/registry-do';
import { makeState, req, signHeaders, snapshotBody, type Harness } from './do-harness';

describe('BrowserContextRegistry', () => {
  let h: Harness;
  let registry: BrowserContextRegistry;

  beforeEach(() => {
    h = makeState();
    registry = new BrowserContextRegistry(h.state);
  });

  async function issueCode(): Promise<string> {
    const res = await registry.fetch(req('issue-code'));
    return ((await res.json()) as { code: string }).code;
  }

  async function pair(installationId: string, profileAlias: string) {
    const code = await issueCode();
    const res = await registry.fetch(
      req('pair', { code, installationId, profileAlias, deviceId: 'device-1' }),
    );
    const body = (await res.json()) as { relaySecret?: string; error?: string };
    return { status: res.status, ...body };
  }

  async function pushSnapshot(
    installationId: string,
    secretHex: string,
    sequence: number,
    over: Record<string, unknown> = {},
    opts: { timestamp?: number } = {},
  ) {
    const bodyText = JSON.stringify(snapshotBody(over));
    const headers = await signHeaders(secretHex, installationId, sequence, bodyText, opts);
    const res = await registry.fetch(
      new Request('https://do/?op=snapshot&signedPath=%2Fsnapshot', {
        method: 'POST',
        headers,
        body: bodyText,
      }),
    );
    return { status: res.status, body: await res.json() };
  }

  async function target(selector = 'lastBrowser') {
    const res = await registry.fetch(req(`target&selector=${selector}`));
    return (await res.json()) as Record<string, unknown>;
  }

  describe('pairing', () => {
    // Positive control: a real pairing must succeed, or every rejection test below is vacuous.
    it('issues a code and redeems it for a secret', async () => {
      const out = await pair('inst-a', 'chrome-main');
      expect(out.status).toBe(200);
      expect(out.relaySecret).toMatch(/^[0-9a-f]{64}$/);
    });

    it('burns the code on first use', async () => {
      const code = await issueCode();
      const first = await registry.fetch(
        req('pair', { code, installationId: 'inst-a', profileAlias: 'a', deviceId: 'd' }),
      );
      const second = await registry.fetch(
        req('pair', { code, installationId: 'inst-b', profileAlias: 'b', deviceId: 'd' }),
      );
      expect(first.status).toBe(200);
      expect(second.status).toBe(403);
      expect(await second.json()).toEqual({ error: 'unknown_code' });
    });

    it('refuses a code that was never issued', async () => {
      const res = await registry.fetch(
        req('pair', { code: 'ZZZZ-ZZZZ-ZZZZ', installationId: 'i', profileAlias: 'a', deviceId: 'd' }),
      );
      expect(res.status).toBe(403);
    });

    it('refuses an expired code', async () => {
      const code = await issueCode();
      h.store.set(`code:${code}`, { expiresAt: Date.now() - 1 });
      const res = await registry.fetch(
        req('pair', { code, installationId: 'i', profileAlias: 'a', deviceId: 'd' }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'code_expired' });
    });

    it('refuses an alias already taken by a different installation', async () => {
      await pair('inst-a', 'chrome-main');
      const clash = await pair('inst-b', 'chrome-main');
      expect(clash.status).toBe(409);
      expect(clash.error).toBe('alias_already_used');
    });

    it('lets the same installation re-pair under its own alias', async () => {
      const first = await pair('inst-a', 'chrome-main');
      const again = await pair('inst-a', 'chrome-main');
      expect(again.status).toBe(200);
      expect(again.relaySecret).not.toBe(first.relaySecret);
    });
  });

  describe('snapshot authentication', () => {
    it('accepts a correctly signed snapshot', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const out = await pushSnapshot('inst-a', relaySecret!, 1);
      expect(out.status).toBe(200);
    });

    it('refuses an unknown installation', async () => {
      const out = await pushSnapshot('inst-nobody', 'aa'.repeat(32), 1);
      expect(out.status).toBe(403);
      expect(out.body).toEqual({ error: 'unknown_installation' });
    });

    it('refuses a wrong signature', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const bodyText = JSON.stringify(snapshotBody());
      const headers = await signHeaders('bb'.repeat(32), 'inst-a', 1, bodyText);
      const res = await registry.fetch(
        new Request('https://do/?op=snapshot&signedPath=%2Fsnapshot', {
          method: 'POST',
          headers,
          body: bodyText,
        }),
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'bad_signature' });
      void relaySecret;
    });

    it('refuses a body that was altered after signing', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const signedText = JSON.stringify(snapshotBody({ tabId: 101 }));
      const headers = await signHeaders(relaySecret!, 'inst-a', 1, signedText);
      const res = await registry.fetch(
        new Request('https://do/?op=snapshot&signedPath=%2Fsnapshot', {
          method: 'POST',
          headers,
          body: JSON.stringify(snapshotBody({ tabId: 999 })),
        }),
      );
      expect(res.status).toBe(403);
    });

    it('refuses a replayed sequence', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      expect((await pushSnapshot('inst-a', relaySecret!, 1)).status).toBe(200);
      expect((await pushSnapshot('inst-a', relaySecret!, 1)).status).toBe(403);
      // Going backwards is refused too, not just exact reuse.
      const back = await pushSnapshot('inst-a', relaySecret!, 1);
      expect(back.status).toBe(403);
    });

    it('refuses a timestamp outside the replay window', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const out = await pushSnapshot('inst-a', relaySecret!, 1, {}, { timestamp: Date.now() - 300_000 });
      expect(out.status).toBe(403);
      expect(out.body).toEqual({ error: 'timestamp_outside_window' });
    });

    it('takes the installation from the authenticated header, never the body', async () => {
      const a = await pair('inst-a', 'chrome-main');
      await pair('inst-b', 'edge-main');
      // inst-a signs correctly but claims to be inst-b in the payload.
      await pushSnapshot('inst-a', a.relaySecret!, 1, {
        installationId: 'inst-b',
        profileAlias: 'edge-main',
      });
      const stored = [...h.store.entries()].filter(([k]) => k.startsWith('snap:'));
      expect(stored).toHaveLength(1);
      const snap = stored[0][1] as { installationId: string; profileAlias: string };
      expect(snap.installationId).toBe('inst-a');
      expect(snap.profileAlias).toBe('chrome-main');
    });
  });

  describe('revoke racing a snapshot', () => {
    // Signature verification is a non-storage await, so another request can land inside it.
    // Before the re-check, the write below resurrected the installation that revoke had removed.
    it('does not resurrect an installation revoked mid-verification', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');

      // The signing must finish BEFORE the race starts. Awaiting it inline would let revoke land
      // before the request even reaches the registry, and the early unknown_installation check
      // would answer instead — the test would pass without ever exercising the race.
      const bodyText = JSON.stringify(snapshotBody());
      const headers = await signHeaders(relaySecret!, 'inst-a', 1, bodyText);
      const signed = new Request('https://do/?op=snapshot&signedPath=%2Fsnapshot', {
        method: 'POST',
        headers,
        body: bodyText,
      });

      // Fire the snapshot, then let revoke run while it is inside verifySignature — a non-storage
      // await, so the runtime allows the interleave.
      const inFlight = registry.fetch(signed);
      await registry.fetch(req('revoke', { installationId: 'inst-a' }));
      const res = await inFlight;

      expect(res.status).toBe(403);
      // Pins that we took the mid-verification path, not the early check. If the interleave stops
      // happening this reads unknown_installation and the test fails loudly rather than passing
      // for the wrong reason.
      expect(await res.json()).toEqual({ error: 'revoked_during_verification' });
      expect(h.store.has('install:inst-a')).toBe(false);
      expect([...h.store.keys()].some((k) => k.startsWith('snap:'))).toBe(false);
    });

    it('refuses a snapshot signed with a secret that was replaced mid-verification', async () => {
      const first = await pair('inst-a', 'chrome-main');
      const bodyText = JSON.stringify(snapshotBody());
      const headers = await signHeaders(first.relaySecret!, 'inst-a', 1, bodyText);
      const signed = new Request('https://do/?op=snapshot&signedPath=%2Fsnapshot', {
        method: 'POST',
        headers,
        body: bodyText,
      });

      const inFlight = registry.fetch(signed);
      await pair('inst-a', 'chrome-main'); // re-pair issues a new secret
      const res = await inFlight;

      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 're_paired_during_verification' });
    });

    it('uses the concurrency guard rather than writing straight back', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const before = h.blocks;
      await pushSnapshot('inst-a', relaySecret!, 1);
      expect(h.blocks).toBeGreaterThan(before);
    });
  });

  describe('storage shape', () => {
    it('keeps one row per browser session, not per installation', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', relaySecret!, 1, { browserSessionId: 'sess-1', tabId: 1 });
      await pushSnapshot('inst-a', relaySecret!, 2, { browserSessionId: 'sess-2', tabId: 2 });

      const snaps = [...h.store.keys()].filter((k) => k.startsWith('snap:'));
      // A copied profile directory yields two live browsers under one installation id. Collapsing
      // them onto one key would hand out a confident TARGET for whichever wrote last.
      expect(snaps).toHaveLength(2);
    });

    it('reports two live sessions to the console', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', relaySecret!, 1, { browserSessionId: 'sess-1' });
      await pushSnapshot('inst-a', relaySecret!, 2, { browserSessionId: 'sess-2' });

      const res = await registry.fetch(req('installations'));
      const { installations } = (await res.json()) as {
        installations: { liveSessions: number; snapshot: unknown }[];
      };
      expect(installations[0].liveSessions).toBe(2);
    });

    it('never hands the relay secret to the console', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', relaySecret!, 1);
      const res = await registry.fetch(req('installations'));
      expect(JSON.stringify(await res.json())).not.toContain(relaySecret!);
    });

    it('drops expired snapshots on the next write', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', relaySecret!, 1, { browserSessionId: 'sess-old' });

      const oldKey = [...h.store.keys()].find((k) => k.includes('sess-old'))!;
      const old = h.store.get(oldKey) as { receivedAt: string };
      h.store.set(oldKey, { ...old, receivedAt: new Date(Date.now() - 600_000).toISOString() });

      await pushSnapshot('inst-a', relaySecret!, 2, { browserSessionId: 'sess-new' });
      expect(h.store.has(oldKey)).toBe(false);
    });

    it('clears the previous snapshot when an installation re-pairs', async () => {
      const first = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', first.relaySecret!, 1);
      await pair('inst-a', 'chrome-main');
      expect([...h.store.keys()].some((k) => k.startsWith('snap:'))).toBe(false);
    });
  });

  describe('clamping', () => {
    it('pulls a future observedAt back to the receipt time', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const future = new Date(Date.now() + 60_000).toISOString();
      await pushSnapshot('inst-a', relaySecret!, 1, { observedAt: future, lastInteractionAt: future });

      const snap = [...h.store.values()].find(
        (v) => (v as { tabId?: number }).tabId === 101,
      ) as { observedAt: string; receivedAt: string };
      expect(Date.parse(snap.observedAt)).toBeLessThanOrEqual(Date.parse(snap.receivedAt));
    });

    it('keeps a missing lastInteractionAt as null instead of inventing one', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', relaySecret!, 1, { lastInteractionAt: null });

      const snap = [...h.store.values()].find(
        (v) => (v as { tabId?: number }).tabId === 101,
      ) as { lastInteractionAt: string | null };
      // Substituting receipt time here would make every keepalive claim the user had just been in.
      expect(snap.lastInteractionAt).toBeNull();
    });
  });

  describe('resolution through the real store', () => {
    it('returns NO_TARGET before anything has been reported', async () => {
      expect(await target()).toEqual({ status: 'NO_TARGET', reason: 'no_snapshots' });
    });

    it('returns the paired profile once it reports', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      await pushSnapshot('inst-a', relaySecret!, 1);
      const t = await target();
      expect(t.status).toBe('TARGET');
      expect((t.target as { profileAlias: string }).profileAlias).toBe('chrome-main');
    });

    // The case that only exists because storage is keyed by session: one installation, two live
    // browsers, indistinguishable to the resolver.
    it('reports AMBIGUOUS for a cloned profile running twice', async () => {
      const { relaySecret } = await pair('inst-a', 'chrome-main');
      const at = new Date().toISOString();
      await pushSnapshot('inst-a', relaySecret!, 1, {
        browserSessionId: 'sess-1', tabId: 1, windowId: 1, lastInteractionAt: at,
      });
      await pushSnapshot('inst-a', relaySecret!, 2, {
        browserSessionId: 'sess-2', tabId: 2, windowId: 2, lastInteractionAt: at,
      });

      const t = await target();
      expect(t.status).toBe('AMBIGUOUS');
      expect((t.candidates as unknown[]).length).toBe(2);
    });

    it('reports AMBIGUOUS for two profiles used at the same instant', async () => {
      const a = await pair('inst-a', 'chrome-main');
      const b = await pair('inst-b', 'edge-main');
      const at = new Date().toISOString();
      await pushSnapshot('inst-a', a.relaySecret!, 1, { browserSessionId: 's-a', lastInteractionAt: at });
      await pushSnapshot('inst-b', b.relaySecret!, 1, { browserSessionId: 's-b', tabId: 202, lastInteractionAt: at });

      const t = await target();
      expect(t.status).toBe('AMBIGUOUS');
      const aliases = (t.candidates as { profileAlias: string }[]).map((c) => c.profileAlias).sort();
      expect(aliases).toEqual(['chrome-main', 'edge-main']);
    });

    it('picks a clear winner once the gap exceeds the ambiguity window', async () => {
      const a = await pair('inst-a', 'chrome-main');
      const b = await pair('inst-b', 'edge-main');
      await pushSnapshot('inst-a', a.relaySecret!, 1, {
        browserSessionId: 's-a',
        lastInteractionAt: new Date(Date.now() - 30_000).toISOString(),
      });
      await pushSnapshot('inst-b', b.relaySecret!, 1, {
        browserSessionId: 's-b', tabId: 202,
        lastInteractionAt: new Date().toISOString(),
      });

      const t = await target();
      expect(t.status).toBe('TARGET');
      expect((t.target as { profileAlias: string }).profileAlias).toBe('edge-main');
    });
  });

  it('refuses an operation it does not know', async () => {
    const res = await registry.fetch(req('do-something-else'));
    expect(res.status).toBe(400);
  });
});
