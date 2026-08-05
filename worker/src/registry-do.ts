import { verifySignature, randomSecretHex } from './auth';
import { parseSelector, resolve, type Snapshot } from './resolve';

/** Snapshots older than this are never returned as a TARGET. */
const TTL_MS = 180_000;
/** Pairing codes are single use and short lived. */
const PAIRING_CODE_TTL_MS = 600_000;

interface Installation {
  installationId: string;
  profileAlias: string;
  secretHex: string;
  lastSequence: number;
  createdAt: string;
}

/**
 * One instance per deviceId. Holds at most one snapshot per installation, so the stored volume
 * is bounded by the number of browser profiles on that machine.
 */
export class BrowserContextRegistry implements DurableObject {
  constructor(private state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const op = url.searchParams.get('op');

    switch (op) {
      case 'issue-code':
        return this.issueCode();
      case 'pair':
        return this.pair(request);
      case 'snapshot':
        return this.snapshot(request, url);
      case 'target':
        return this.target(url);
      case 'installations':
        return this.installations();
      case 'revoke':
        return this.revoke(request);
      default:
        return json({ error: 'unknown_op' }, 400);
    }
  }

  private async issueCode(): Promise<Response> {
    const code = [0, 1, 2]
      .map(() => Math.random().toString(36).slice(2, 6).toUpperCase())
      .join('-');
    await this.state.storage.put(`code:${code}`, { expiresAt: Date.now() + PAIRING_CODE_TTL_MS });
    return json({ code, expiresInMs: PAIRING_CODE_TTL_MS });
  }

  private async pair(request: Request): Promise<Response> {
    const { code, installationId, profileAlias, deviceId } = await request.json<{
      code: string;
      installationId: string;
      profileAlias: string;
      deviceId: string;
    }>();

    if (!code || !installationId || !profileAlias) return json({ error: 'missing_fields' }, 400);

    const entry = await this.state.storage.get<{ expiresAt: number }>(`code:${code}`);
    if (!entry) return json({ error: 'unknown_code' }, 403);
    // Single use: burn it whether or not the rest succeeds.
    await this.state.storage.delete(`code:${code}`);
    if (entry.expiresAt < Date.now()) return json({ error: 'code_expired' }, 403);

    const installations = await this.listInstallations();
    const clash = installations.find(
      (i) => i.profileAlias === profileAlias && i.installationId !== installationId,
    );
    if (clash) return json({ error: 'alias_already_used' }, 409);

    const secretHex = randomSecretHex();
    const installation: Installation = {
      installationId,
      profileAlias,
      secretHex,
      lastSequence: 0,
      createdAt: new Date().toISOString(),
    };
    await this.state.storage.put(`install:${installationId}`, installation);
    // A re-pair invalidates whatever the previous installation reported, across every session.
    await this.deleteSnapshotsFor(installationId);

    return json({ deviceId, relaySecret: secretHex });
  }

  private async snapshot(request: Request, url: URL): Promise<Response> {
    const installationId = request.headers.get('x-bcc-installation');
    if (!installationId) return json({ error: 'missing_installation' }, 400);

    const installation = await this.state.storage.get<Installation>(`install:${installationId}`);
    if (!installation) return json({ error: 'unknown_installation' }, 403);

    const body = await request.text();
    // Verifying is a non-storage await, so other requests to this object can and will interleave
    // here. Nothing read before this point may be trusted afterwards.
    const verdict = await verifySignature({
      method: 'POST',
      path: url.searchParams.get('signedPath') ?? '/snapshot',
      body,
      timestamp: request.headers.get('x-bcc-timestamp'),
      sequence: request.headers.get('x-bcc-sequence'),
      signature: request.headers.get('x-bcc-signature'),
      secretHex: installation.secretHex,
      lastSequence: installation.lastSequence,
      now: Date.now(),
    });
    if (!verdict.ok) return json({ error: verdict.reason }, 403);

    let payload: Omit<Snapshot, 'receivedAt' | 'sequence'>;
    try {
      payload = JSON.parse(body);
    } catch {
      return json({ error: 'bad_json' }, 400);
    }

    // Re-read and re-check under a concurrency block. Without this, a revoke that lands during
    // verification would be undone by the write below, resurrecting a secret the user just
    // withdrew — and two snapshots verified out of order would roll `lastSequence` backwards,
    // reopening the replay window.
    return this.state.blockConcurrencyWhile(async () => {
      const current = await this.state.storage.get<Installation>(`install:${installationId}`);
      if (!current) return json({ error: 'revoked_during_verification' }, 403);
      if (current.secretHex !== installation.secretHex) {
        return json({ error: 're_paired_during_verification' }, 403);
      }
      if (verdict.sequence <= current.lastSequence) {
        return json({ error: 'sequence_replayed' }, 403);
      }

      const receivedAt = new Date();
      // A client clock running fast would otherwise let a snapshot sit "in the future", get
      // skipped as unusable, and then quietly become the freshest target minutes later — long
      // after the browser may have closed.
      const observed = Date.parse(payload.observedAt);
      const observedAt =
        Number.isFinite(observed) && observed < receivedAt.getTime()
          ? payload.observedAt
          : receivedAt.toISOString();
      const interaction = Date.parse(payload.lastInteractionAt);
      const lastInteractionAt =
        Number.isFinite(interaction) && interaction < receivedAt.getTime()
          ? payload.lastInteractionAt
          : receivedAt.toISOString();

      // The installation id is taken from the authenticated header, never from the body, so a
      // signed request cannot claim to be a different profile.
      const stored: Snapshot = {
        ...payload,
        installationId,
        profileAlias: current.profileAlias,
        observedAt,
        lastInteractionAt,
        receivedAt: receivedAt.toISOString(),
        sequence: verdict.sequence,
      };

      // Keyed by browser session as well as installation: a copied profile directory yields two
      // live browsers sharing one installation id, and collapsing them onto one key would hand
      // out a confident TARGET for whichever wrote last instead of reporting AMBIGUOUS.
      await this.state.storage.put(snapshotKey(installationId, stored.browserSessionId), stored);
      await this.state.storage.put(`install:${installationId}`, {
        ...current,
        lastSequence: verdict.sequence,
      });

      await this.pruneExpired(receivedAt.getTime());
      return json({ ok: true });
    });
  }

  /** Sessions end without saying so, so expired rows are dropped on the next write. */
  private async pruneExpired(now: number): Promise<void> {
    const map = await this.state.storage.list<Snapshot>({ prefix: 'snap:' });
    const dead: string[] = [];
    for (const [key, snap] of map) {
      const age = now - Date.parse(snap.receivedAt);
      if (!Number.isFinite(age) || age > TTL_MS) dead.push(key);
    }
    if (dead.length) await this.state.storage.delete(dead);
  }

  private async target(url: URL): Promise<Response> {
    const snapshots = await this.listSnapshots();
    const resolution = resolve(snapshots, parseSelector(url.searchParams.get('selector')), Date.now(), TTL_MS);
    return json(resolution);
  }

  /** Console view: every paired profile with its latest snapshot, if any. */
  private async installations(): Promise<Response> {
    const [installations, snapshots] = await Promise.all([this.listInstallations(), this.listSnapshots()]);

    const grouped = new Map<string, Snapshot[]>();
    for (const s of snapshots) {
      const bucket = grouped.get(s.installationId);
      if (bucket) bucket.push(s);
      else grouped.set(s.installationId, [s]);
    }

    return json({
      installations: installations
        .map((i) => {
          const own = (grouped.get(i.installationId) ?? []).sort(
            (a, b) => Date.parse(b.receivedAt) - Date.parse(a.receivedAt),
          );
          return {
            installationId: i.installationId,
            profileAlias: i.profileAlias,
            createdAt: i.createdAt,
            // More than one live session under a single installation means the profile directory
            // was copied. Worth showing: the two browsers are indistinguishable to the resolver.
            liveSessions: own.length,
            // The secret never leaves the Durable Object, not even to an authenticated console.
            snapshot: own[0] ?? null,
          };
        })
        .sort((a, b) => a.profileAlias.localeCompare(b.profileAlias)),
    });
  }

  private async revoke(request: Request): Promise<Response> {
    const { installationId } = await request.json<{ installationId: string }>();
    if (!installationId) return json({ error: 'missing_fields' }, 400);
    // Blocked so a snapshot verifying concurrently cannot write the installation back afterwards.
    return this.state.blockConcurrencyWhile(async () => {
      await this.state.storage.delete(`install:${installationId}`);
      await this.deleteSnapshotsFor(installationId);
      return json({ ok: true });
    });
  }

  private async deleteSnapshotsFor(installationId: string): Promise<void> {
    const map = await this.state.storage.list<Snapshot>({ prefix: `snap:${installationId}:` });
    if (map.size) await this.state.storage.delete([...map.keys()]);
  }

  private async listInstallations(): Promise<Installation[]> {
    const map = await this.state.storage.list<Installation>({ prefix: 'install:' });
    return [...map.values()];
  }

  private async listSnapshots(): Promise<Snapshot[]> {
    const map = await this.state.storage.list<Snapshot>({ prefix: 'snap:' });
    return [...map.values()];
  }
}

/** `:` separates the two parts; neither a UUID nor a session id contains one. */
function snapshotKey(installationId: string, browserSessionId: string): string {
  return `snap:${installationId}:${browserSessionId}`;
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
