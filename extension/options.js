import { getInstallationId } from './lib/ids.js';

const DEFAULT_ENDPOINT = 'https://dashboard.dxj.jp/browser-check/ingest/v1';

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
  const code = $('pairingCode').value.trim();
  if (!alias) return setStatus($('pairStatus'), 'プロファイル名を入力してください。', 'err');
  if (!code) return setStatus($('pairStatus'), 'ペアリングコードを入力してください。', 'err');

  const endpoint = (await chrome.storage.local.get('endpoint')).endpoint || DEFAULT_ENDPOINT;
  const installationId = await getInstallationId();

  setStatus($('pairStatus'), 'ペアリング中…');
  try {
    const res = await fetch(endpoint + '/pair', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, installationId, profileAlias: alias }),
    });
    if (!res.ok) {
      const detail = await res.text();
      return setStatus($('pairStatus'), `ペアリング失敗: ${res.status} ${detail.slice(0, 120)}`, 'err');
    }
    const { deviceId, relaySecret } = await res.json();
    await chrome.storage.local.set({ deviceId, relaySecret, profileAlias: alias, sequence: 0 });
    $('pairingCode').value = '';
    setStatus($('pairStatus'), `ペアリング完了（device: ${deviceId}）`, 'ok');
  } catch (err) {
    setStatus($('pairStatus'), `ペアリング失敗: ${err.message}`, 'err');
  }
});

$('unpair').addEventListener('click', async () => {
  await chrome.storage.local.remove(['deviceId', 'relaySecret', 'sequence']);
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
