import { detectBrowser } from './lib/browser-kind.js';

const $ = (id) => document.getElementById(id);

(async () => {
  const { agentMode, profileAlias, lastPushStatus } = await chrome.storage.local.get([
    'agentMode',
    'profileAlias',
    'lastPushStatus',
  ]);

  $('mode').textContent = agentMode ? 'ON' : 'OFF';
  $('mode').className = 'badge ' + (agentMode ? 'on' : 'off');
  $('alias').textContent = profileAlias || '(未設定)';

  // A rejected push leaves Agent Mode looking healthy, so the failure has to be visible here.
  if (agentMode && lastPushStatus && !lastPushStatus.ok) {
    const el = $('pushError');
    el.textContent =
      lastPushStatus.status === 403
        ? '送信が拒否されました。設定画面で再ペアリングしてください。'
        : `送信に失敗しています（${lastPushStatus.status || 'ネットワーク'}）。`;
    el.hidden = false;
  }

  const browser = await detectBrowser();
  $('browser').textContent = [browser.browserKind, browser.engineVersion].filter(Boolean).join(' ');

  // The popup runs on a user gesture, so tab identity is readable even without the tabs
  // permission. url/title are not, and are deliberately not shown here.
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    $('tabId').textContent = String(tab.id);
    $('windowId').textContent = String(tab.windowId);
  }
})();

$('openOptions').addEventListener('click', () => chrome.runtime.openOptionsPage());
