// Human-facing console, served inline by the Worker.
//
// Lives behind the dashboard.dxj.jp Access application, so everything reachable from here is
// already authenticated. Pairing codes are issued from this page and nowhere else.
//
// Styling follows the DXJ Design System (「白の規律」): light is the default, dark is an explicit
// user choice persisted in localStorage. prefers-color-scheme must not override the default.

export const CONSOLE_HTML = /* html */ `<!DOCTYPE html>
<html lang="ja" data-theme="light">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Browser Context Check — Console</title>
<script>
  // Applied before first paint so a dark-mode user never sees a white flash.
  (function () {
    try {
      var t = localStorage.getItem('dxj-theme');
      if (t === 'dark' || t === 'light') document.documentElement.dataset.theme = t;
    } catch (e) {}
  })();
</script>
<style>
:root {
  --ink-0:#ffffff; --ink-50:#fafafb; --ink-100:#f0f1f3; --ink-200:#e4e6ea; --ink-300:#c7cad1;
  --ink-400:#6e727c; --ink-600:#3a3d45; --ink-800:#202127; --ink-900:#1a1b1e;
  --blue-300:#7ba1f2; --blue-500:#1757e0; --blue-600:#1046b8;
  --shu-500:#c9342c;
  --font-sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Hiragino Kaku Gothic ProN", "Hiragino Sans", "Yu Gothic Medium", "Yu Gothic", "Meiryo", sans-serif;
  --font-mono: ui-monospace, "Cascadia Mono", "Consolas", "Menlo", monospace;

  --bg: var(--ink-0); --surface: var(--ink-0); --surface-raised: var(--ink-50);
  --fg: var(--ink-900); --fg-muted: var(--ink-600); --fg-subtle: var(--ink-400);
  --fg-brand: var(--blue-600);
  --border: var(--ink-200); --border-strong: var(--ink-300);
  --ok:#0f7b4f; --warn:#8a6100; --danger: var(--shu-500);
}
:root[data-theme="dark"] {
  --bg: var(--ink-900); --surface: var(--ink-800); --surface-raised:#24262d;
  --fg: var(--ink-0); --fg-muted: var(--ink-300); --fg-subtle: var(--ink-400);
  --fg-brand: var(--blue-300);
  --border:#262930; --border-strong:#343841;
  --ok:#4ade80; --warn:#fbbf24; --danger:#f87171;
}
* { box-sizing: border-box; }
body {
  margin:0; padding:48px 24px; background:var(--bg); color:var(--fg);
  font-family:var(--font-sans); font-size:16px; line-height:1.8;
}
.wrap { max-width:900px; margin:0 auto; }
header { display:flex; align-items:baseline; gap:16px; margin-bottom:8px; }
h1 { font-size:24px; font-weight:600; margin:0; letter-spacing:.01em; }
.sub { color:var(--fg-subtle); font-size:14px; margin:0 0 48px; }
h2 { font-size:16px; font-weight:600; margin:0 0 16px; }
section { border-top:1px solid var(--border); padding:32px 0; }
#theme {
  margin-left:auto; background:none; border:1px solid var(--border); color:var(--fg-muted);
  border-radius:999px; padding:4px 14px; font-size:13px; cursor:pointer; font-family:inherit;
}
#theme:hover { border-color:var(--border-strong); color:var(--fg); }
table { width:100%; border-collapse:collapse; font-size:14px; }
th, td { text-align:left; padding:12px 12px 12px 0; border-bottom:1px solid var(--border); vertical-align:top; }
th { color:var(--fg-subtle); font-weight:500; font-size:13px; white-space:nowrap; }
td.mono, .mono { font-family:var(--font-mono); font-size:13px; overflow-wrap:anywhere; }
.scroll { overflow-x:auto; }
.tag { display:inline-block; padding:1px 10px; border-radius:999px; font-size:12px; border:1px solid var(--border-strong); color:var(--fg-muted); }
.tag.ok { color:var(--ok); border-color:currentColor; }
.tag.warn { color:var(--warn); border-color:currentColor; }
.tag.bad { color:var(--danger); border-color:currentColor; }
button.act {
  font-family:inherit; font-size:14px; padding:8px 18px; border-radius:6px; cursor:pointer;
  border:1px solid var(--blue-500); background:var(--blue-500); color:#fff;
}
button.act:hover { background:var(--blue-600); border-color:var(--blue-600); }
button.ghost { background:none; color:var(--fg-muted); border-color:var(--border-strong); }
button.ghost:hover { color:var(--fg); }
button.danger { background:none; color:var(--danger); border-color:currentColor; }
.row { display:flex; gap:12px; align-items:center; flex-wrap:wrap; }
.code {
  font-family:var(--font-mono); font-size:12px; line-height:1.6; padding:16px 20px;
  background:var(--surface-raised); border:1px solid var(--border); border-radius:8px;
  display:block; margin:16px 0 8px; overflow-wrap:anywhere; max-height:180px; overflow-y:auto;
}
.muted { color:var(--fg-subtle); font-size:14px; }
.empty { color:var(--fg-subtle); font-size:14px; padding:24px 0; }
select {
  font-family:inherit; font-size:14px; padding:7px 10px; border-radius:6px;
  border:1px solid var(--border); background:var(--surface); color:var(--fg);
}
pre {
  background:var(--surface-raised); border:1px solid var(--border); border-radius:8px;
  padding:16px; overflow-x:auto; font-family:var(--font-mono); font-size:13px; line-height:1.6; margin:16px 0 0;
}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Browser Context Check</h1>
    <button id="theme" type="button">テーマ</button>
  </header>
  <p class="sub">ペアリング済みプロファイルの一覧と、エージェントがいま解決する対象を確認します。</p>

  <section>
    <h2>いまエージェントが見る対象</h2>
    <div class="row">
      <select id="selector">
        <option value="lastBrowser">lastBrowser — 最後に見ていたタブ（既定）</option>
        <option value="foreground">foreground — いまフォーカスがあるタブ</option>
      </select>
      <button class="act ghost" id="resolve" type="button">解決する</button>
    </div>
    <pre id="resolveOut">—</pre>
  </section>

  <section>
    <h2>ペアリング済みプロファイル</h2>
    <div class="scroll"><table>
      <thead><tr>
        <th>プロファイル</th><th>ブラウザ</th><th>状態</th><th>tab / window</th><th>最終受信</th><th></th>
      </tr></thead>
      <tbody id="rows"></tbody>
    </table></div>
    <p id="empty" class="empty" hidden>まだペアリングされていません。下でバンドルを発行してください。</p>
  </section>

  <section>
    <h2>新しいプロファイルを追加</h2>
    <p class="muted">
      バンドルを発行し、対象ブラウザの拡張の設定画面に貼り付けます。1回限り・10分で失効します。
      <strong>資格情報を含むため、他人に渡さないでください。</strong>
    </p>
    <div class="row">
      <button class="act" id="issue" type="button">ペアリングバンドルを発行</button>
      <button class="act ghost" id="copy" type="button" hidden>コピー</button>
    </div>
    <div id="codeBox" hidden><div class="code" id="code">—</div><p class="muted" id="codeNote"></p></div>
  </section>
</div>

<script>
const $ = (id) => document.getElementById(id);
const API = './api/v1';
// Proves the request came from this page rather than from a cross-site form riding the Access
// cookie. Any request carrying it is forced through a preflight the api prefix will not answer.
const CONSOLE_HEADERS = { 'x-bcc-console': '1' };

$('theme').addEventListener('click', () => {
  const next = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  document.documentElement.dataset.theme = next;
  try { localStorage.setItem('dxj-theme', next); } catch (e) {}
});

function freshness(snapshot) {
  if (!snapshot) return { cls: 'bad', label: '未受信' };
  const ageMs = Date.now() - Date.parse(snapshot.observedAt);
  if (!Number.isFinite(ageMs)) return { cls: 'bad', label: '時刻不正' };
  if (ageMs > 180000) return { cls: 'warn', label: '失効 (' + Math.round(ageMs / 1000) + 's)' };
  if (snapshot.focusState === 'foreground') return { cls: 'ok', label: 'フォーカス中' };
  return { cls: 'ok', label: '待機' };
}

function relative(iso) {
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return '—';
  if (ms < 60000) return Math.max(0, Math.round(ms / 1000)) + '秒前';
  if (ms < 3600000) return Math.round(ms / 60000) + '分前';
  return Math.round(ms / 3600000) + '時間前';
}

async function load() {
  const res = await fetch(API + '/installations');
  const { installations } = await res.json();
  const tbody = $('rows');
  tbody.textContent = '';
  $('empty').hidden = installations.length > 0;

  for (const item of installations) {
    const s = item.snapshot;
    const state = freshness(s);
    const tr = document.createElement('tr');

    const cells = [
      { text: item.profileAlias },
      { text: s ? [s.browserKind, s.engineVersion].filter(Boolean).join(' ') : '—' },
      { html: '<span class="tag ' + state.cls + '">' + state.label + '</span>' },
      { text: s ? s.tabId + ' / ' + s.windowId : '—', mono: true },
      { text: s ? relative(s.observedAt) : '—' },
    ];
    for (const c of cells) {
      const td = document.createElement('td');
      if (c.mono) td.className = 'mono';
      if (c.html) td.innerHTML = c.html; else td.textContent = c.text;
      tr.appendChild(td);
    }

    const actions = document.createElement('td');
    const revoke = document.createElement('button');
    revoke.className = 'act danger';
    revoke.type = 'button';
    revoke.textContent = '解除';
    revoke.addEventListener('click', async () => {
      if (!confirm(item.profileAlias + ' のペアリングを解除しますか？')) return;
      await fetch(API + '/revoke', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...CONSOLE_HEADERS },
        body: JSON.stringify({ installationId: item.installationId }),
      });
      load();
    });
    actions.appendChild(revoke);
    tr.appendChild(actions);
    tbody.appendChild(tr);
  }
}

$('resolve').addEventListener('click', async () => {
  const res = await fetch(API + '/target?selector=' + encodeURIComponent($('selector').value));
  $('resolveOut').textContent = JSON.stringify(await res.json(), null, 2);
});

$('issue').addEventListener('click', async () => {
  const res = await fetch(API + '/pairing-code', { method: 'POST', headers: CONSOLE_HEADERS });
  const { bundle, expiresInMs } = await res.json();
  $('code').textContent = bundle;
  $('codeNote').textContent = Math.round(expiresInMs / 60000) + '分で失効します。';
  $('codeBox').hidden = false;
  $('copy').hidden = false;
});

$('copy').addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText($('code').textContent);
    $('copy').textContent = 'コピーしました';
    setTimeout(() => { $('copy').textContent = 'コピー'; }, 1500);
  } catch (e) {
    $('codeNote').textContent = 'コピーできませんでした。手動で選択してください。';
  }
});

load();
setInterval(load, 15000);
</script>
</body>
</html>`;
