import { getInstallationId } from './lib/ids.js';
import { accessHeaders } from './lib/relay.js';

const DEFAULT_ENDPOINT = 'https://dashboard.dxj.jp/browser-check/ingest/v1';

/**
 * The relay host is behind Cloudflare Access, so a brand new installation cannot reach it to ask
 * for credentials — that would be circular. The console therefore emits a bundle that the human
 * carries across: Access service-token credentials plus a single-use redemption code.
 */
function decodeBundle(raw) {
  let json;
  try {
    json = JSON.parse(atob(raw.replace(/\s+/g, '')));
  } catch {
    return { ok: false, reason: 'バンドルを読み取れません。コンソールからコピーし直してください。' };
  }
  const missing = ['code', 'accessClientId', 'accessClientSecret'].filter((k) => !json[k]);
  if (missing.length) return { ok: false, reason: `バンドルに ${missing.join(', ')} がありません。` };
  return { ok: true, bundle: json };
}

const $ = (id) => document.getElementById(id);

function setStatus(el, text, kind) {
  el.textContent = text;
  el.className = 'status' + (kind ? ' ' + kind : '');
}

async function load() {
  const stored = await chrome.storage.local.get([
    'agentMode', 'sendTitle', 'includeIncognito', 'endpoint', 'profileAlias', 'relaySecret', 'deviceId',
  ]);

  $('endpointLabel').textContent = stored.endpoint || DEFAULT_ENDPOINT;
  $('agentMode').checked = Boolean(stored.agentMode);
  $('sendTitle').checked = Boolean(stored.sendTitle);
  $('includeIncognito').checked = Boolean(stored.includeIncognito);
  $('profileAlias').value = stored.profileAlias || '';

  if (stored.relaySecret && stored.deviceId) {
    setStatus($('pairStatus'), `ペアリング済み（device: ${stored.deviceId}）`, 'ok');
  } else {
    setStatus($('pairStatus'), '未ペアリング。Agent Mode は有効にできません。');
  }
  await refreshPermStatus();
}

async function refreshPermStatus() {
  const granted = await chrome.permissions.contains({ permissions: ['tabs'] });
  setStatus(
    $('permStatus'),
    granted
      ? 'タブ情報の読み取りを許可済みです。'
      : 'Agent Mode を有効にすると、タブ情報の読み取り許可を求めます。',
    granted ? 'ok' : undefined,
  );
}

$('pair').addEventListener('click', async () => {
  const alias = $('profileAlias').value.trim();
  const raw = $('pairingCode').value.trim();
  if (!alias) return setStatus($('pairStatus'), 'プロファイル名を入力してください。', 'err');
  if (!raw) return setStatus($('pairStatus'), 'ペアリングバンドルを貼り付けてください。', 'err');

  const decoded = decodeBundle(raw);
  if (!decoded.ok) return setStatus($('pairStatus'), decoded.reason, 'err');
  const { code, accessClientId, accessClientSecret, endpoint: bundleEndpoint } = decoded.bundle;

  const endpoint = bundleEndpoint || (await chrome.storage.local.get('endpoint')).endpoint || DEFAULT_ENDPOINT;
  const installationId = await getInstallationId();
  const access = { clientId: accessClientId, clientSecret: accessClientSecret };

  setStatus($('pairStatus'), 'ペアリング中…');
  try {
    const res = await fetch(endpoint + '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...accessHeaders(access) },
      body: JSON.stringify({ code, installationId, profileAlias: alias }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return setStatus($('pairStatus'), `ペアリング失敗: ${res.status} ${detail.slice(0, 120)}`, 'err');
    }
    const { deviceId, relaySecret } = await res.json();
    // Only persist the Access credentials once they have actually authenticated a request.
    await chrome.storage.local.set({
      deviceId,
      relaySecret,
      profileAlias: alias,
      endpoint,
      accessClientId,
      accessClientSecret,
      sequence: 0,
    });
    $('pairingCode').value = '';
    setStatus($('pairStatus'), `ペアリング完了（device: ${deviceId}）`, 'ok');
  } catch (err) {
    setStatus($('pairStatus'), `ペアリング失敗: ${err.message}`, 'err');
  }
});

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove([
    'deviceId',
    'relaySecret',
    'sequence',
    'accessClientId',
    'accessClientSecret',
  ]);
  await chrome.storage.local.set({ agentMode: false });
  $('agentMode').checked = false;
  setStatus($('pairStatus'), '解除しました。送信は停止しています。');
});

$('agentMode').addEventListener('change', async (e) => {
  if (!e.target.checked) {
    await chrome.storage.local.set({ agentMode: false });
    return;
  }

  const { relaySecret, deviceId } = await chrome.storage.local.get(['relaySecret', 'deviceId']);
  if (!relaySecret || !deviceId) {
    e.target.checked = false;
    return setStatus($('pairStatus'), '先にペアリングしてください。', 'err');
  }

  // The tabs permission is requested here, in response to a user gesture, rather than at install
  // time. Without it url/title are unreadable and there is nothing to report.
  const granted = await chrome.permissions.request({ permissions: ['tabs'] });
  if (!granted) {
    e.target.checked = false;
    return refreshPermStatus();
  }

  await chrome.storage.local.set({ agentMode: true });
  await refreshPermStatus();
});

for (const key of ['sendTitle', 'includeIncognito']) {
  $(key).addEventListener('change', (e) => chrome.storage.local.set({ [key]: e.target.checked }));
}

load();
