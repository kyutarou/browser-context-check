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
    // A re-pair invalidates whatever the previous installation reported.
    await this.state.storage.delete(`snap:${installationId}`);

    return json({ deviceId, relaySecret: secretHex });
  }

  private async snapshot(request: Request, url: URL): Promise<Response> {
    const installationId = request.headers.get('x-bcc-installation');
    if (!installationId) return json({ error: 'missing_installation' }, 400);

    const installation = await this.state.storage.get<Installation>(`install:${installationId}`);
    if (!installation) return json({ error: 'unknown_installation' }, 403);

    const body = await request.text();
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

    // The installation id is taken from the authenticated header, never from the body, so a
    // signed request cannot claim to be a different profile.
    const stored: Snapshot = {
      ...payload,
      installationId,
      profileAlias: installation.profileAlias,
      receivedAt: new Date().toISOString(),
      sequence: verdict.sequence,
    };

    await this.state.storage.put(`snap:${installationId}`, stored);
    await this.state.storage.put(`install:${installationId}`, {
      ...installation,
      lastSequence: verdict.sequence,
    });

    return json({ ok: true });
  }

  private async target(url: URL): Promise<Response> {
    const snapshots = await this.listSnapshots();
    const resolution = resolve(snapshots, parseSelector(url.searchParams.get('selector')), Date.now(), TTL_MS);
    return json(resolution);
  }

  private async revoke(request: Request): Promise<Response> {
    const { installationId } = await request.json<{ installationId: string }>();
    if (!installationId) return json({ error: 'missing_fields' }, 400);
    await this.state.storage.delete(`install:${installationId}`);
    await this.state.storage.delete(`snap:${installationId}`);
    return json({ ok: true });
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

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
