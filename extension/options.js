import { DEFAULT_ENDPOINT, pairWithBundle } from './lib/pair.js';

// Manual paste stays available as the fallback for when the console cannot reach this profile —
// a different browser, or a machine where the console is not open.

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
  const raw = $('pairingCode').value.trim();
  if (!raw) return setStatus($('pairStatus'), 'ペアリングバンドルを貼り付けてください。', 'err');

  setStatus($('pairStatus'), 'ペアリング中…');
  const result = await pairWithBundle(raw, $('profileAlias').value);
  if (!result.ok) return setStatus($('pairStatus'), result.reason, 'err');

  $('pairingCode').value = '';
  setStatus($('pairStatus'), `ペアリング完了（device: ${result.deviceId}）`, 'ok');
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
