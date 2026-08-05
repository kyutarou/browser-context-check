# Browser Context Check — 設計基準（as-built baseline v0.1.0）

> 本書は設計基準であり、稼働の事実は記録しない。稼働記録は `/reports/` に追記する。
> 版を上げるのは設計不変条件が変わったときだけ。

## 0. 目的と非目的

**目的**: ローカルで動く CLI 型 AI エージェントが、「いま操作対象にすべきブラウザ・プロファイル・タブ」を
人手を介さず特定できるようにする。

**非目的**:

- タブを操作すること。本システムは**ビーコンであってタブハンドルではない**。
- 拡張の `tabId` を操作ドライバの target ID として使うこと。両者は別世界の識別子であり、
  混ぜると誤マッピング源になる。操作は claude-in-chrome 等のドライバが自分の target ID で行う。

## 1. 不変条件（変更には版上げが必要）

| ID | 不変条件 |
|---|---|
| INV-1 | 外部送信・background 監視・Incognito 収集は**既定 OFF**。pairing 完了まで一切送信しない |
| INV-2 | `tabs` 権限は **optional**。Agent Mode 有効化時にのみ要求する |
| INV-3 | 拡張バイナリに共有シークレットを埋め込まない。OSS では秘密にならない |
| INV-4 | target の同一性は単一の `tabId` ではなく複合キーで表す |
| INV-5 | 曖昧な候補が同時に存在するとき latest-wins で1件に畳まない。`AMBIGUOUS` を返す |
| INV-6 | Worker のログ・Analytics・エラートレースに snapshot body を残さない |
| INV-7 | 既存の公開拡張 `show-tab-id` には本機能を載せない（信頼境界の変更にあたるため） |
| INV-8 | Access を迂回する経路を作らない。`ingest/` は専用 Access アプリ＋Service Auth で認証する。特権操作（バンドル発行・解除・読み取り）を ingest 側へ置かない |
| INV-9 | `relaySecret` は Durable Object の外へ出さない。認証済みコンソールにも返さない |

## 2. 識別子

```
targetRef :=
    deviceId          # pairing 時に発行。同一PCの全プロファイルを束ねる
  + installationId    # 拡張インストールごとの UUID（storage.local）
  + browserSessionId  # ブラウザ起動ごとの UUID（storage.session。再起動で消える）
  + incognito         # bool。storage.local は通常モードと共有されるため必須
  + windowId
  + tabId
```

`tabId` / `windowId` はブラウザセッション内でしか一意でない。Chrome・Edge・別プロファイルで同じ数値が
同時に存在し、再起動後に再利用される。単独で識別子に使わない。

**プロファイルのディレクトリ名（`Default` / `Profile 2`）は取得できない。**
公開 Extensions API に Profile Path / ディレクトリ名 / UI 表示名を返すものは存在せず、
`chrome://version` の DOM も読めない。したがって人間が pairing 時に一度だけ付ける
`profileAlias`（例 `chrome-work`, `chrome-profile-2`, `edge-main`）を論理名とする。

`installationId` は「Profile 2 そのもののID」ではなく「そのプロファイルに入ったこの拡張インスタンスのID」。
拡張の再インストールで変わり、プロファイルディレクトリのコピーで複製され得る。

`chrome.identity` のアカウント email は識別子に**使わない**（未ログインで空、Edge は MSA、
Brave は GAIA 無効、同一人物の複数プロファイルを区別できない）。

## 3. ブラウザ判定

`navigator.userAgentData` は extension service worker（`WorkerNavigator`）で利用でき、permission 不要。

- `brands` 配列には GREASE のダミーが混ざり順序も不定。**先頭要素をブラウザ名にしない**。既知ブランドの
  allowlist で解析する。
- Brave は `navigator.brave.isBrave()` が service worker でも使える。
- Brave の UA-CH brand version は製品版 `1.x` ではなく Chromium メジャー版になり得る。

出力スキーマ:

| フィールド | 内容 |
|---|---|
| `browserKind` | `chrome \| edge \| brave \| chromium \| unknown` |
| `engineVersion` | UA-CH 由来の Chromium バージョン |
| `productVersion` | 取得できたときだけ。**nullable** |

## 4. 「現在のタブ」は2種類ある

CLI を使うためにターミナルへフォーカスを移すと全ブラウザは unfocused になる。したがって
人間→CLI の流れでは「今フォーカスがあるタブ」は必ず空になり得る。

| selector | 意味 | 想定用途 |
|---|---|---|
| `lastBrowser` | ユーザーがターミナルへ移る直前に最後に見ていたブラウザタブ | **通常の CLI 利用（既定）** |
| `foreground` | いま OS フォーカスを持つブラウザタブ | 完全自律処理 |
| `alias:<name>` | `profileAlias` 指定 | 明示指定 |

Chrome は全ウィンドウがフォーカスを失うと `windows.onFocusChanged` に `WINDOW_ID_NONE` を返す。
ただし複数ブラウザ／プロファイル間のイベントは単一トランザクションではないため、
複数候補が同時に focused かつ fresh に見える瞬間は `AMBIGUOUS` とする（INV-5）。

## 5. 到達経路

拡張 → Cloudflare Worker relay → CLI。

MV3 service worker は listen できないため受動的 API サーバにはなれない。外向きの `fetch` は可能。
約30秒の非活動で終了するため常駐プロセス扱いにしない。

却下した経路と理由:

| 経路 | 却下理由 |
|---|---|
| Native Messaging | 最も確実だが host manifest + 実行体 + レジストリ登録が要る（追加ローカル実行体なしの制約に反する） |
| localhost HTTP/WS | 受け口不在時にイベントが欠落する。再接続とポート競合 |
| `chrome.downloads` | **絶対固定パスを指定できない**（Downloads 配下の相対のみ）。平文残存・履歴汚染 |
| ページ DOM | content script と対象ページが必要。結局 CLI から読む別ブリッジが要る |
| CDP / DevTools MCP 直結 | 観測IDと操作IDが同じ世界になる点は最良だが、remote debugging 有効化と接続承認が要る |

## 6. Access 境界と API（v0）

`dashboard.dxj.jp` はホスト全体が Cloudflare Access（self_hosted アプリ）配下にある。
拡張は人間の SSO セッションを持てないが、**Bypass は作らない**。
代わりに ingest パスへ**専用の Access アプリ**を置き、**Service Auth（サービストークン）**で
機械として認証する。Access は外れず、認証方式が変わるだけである。

境界は**エンドポイントの列挙ではなくプレフィックスで**表現する。列挙はいずれ漏れ、
漏れた側は fail-open になる。

| プレフィックス | 呼び手 | 保護 |
|---|---|---|
| `/browser-check/` | 人間（コンソール） | Access（SSO） |
| `/browser-check/api/v1/` | 人間・CLI | Access（SSO / service token） |
| `/browser-check/ingest/v1/` | 拡張のみ | **Access（Service Auth）** + HMAC 署名 |

ingest 用トークンは ingest パス専用の Access アプリにしか紐づかないため、拡張が侵害されても
コンソールや読み取り API には到達できない。実測で確認済み（`api/v1/target` へ ingest
トークンで到達すると 401）。

| メソッド | パス | 呼び手 |
|---|---|---|
| POST | `ingest/v1/snapshot` | 拡張 |
| POST | `ingest/v1/pair` | 拡張（1回限りのコードを引き換え） |
| GET | `api/v1/target?selector=` | CLI |
| GET | `api/v1/installations` | コンソール |
| POST | `api/v1/pairing-code` | コンソール |
| POST | `api/v1/revoke` | コンソール |

**pairing バンドルの発行は `api/` 側に置く**（INV-8）。ingest 側に置くと発行そのものが
機械資格情報だけで可能になり、ペアリングが意味を失う。

### ペアリングバンドル

新規インストール直後の拡張は Access 資格情報を持たないため、自力では relay に到達できない。
これは循環であり、**初回だけ帯域外で運ぶ**しかない。コンソール（Access 配下）が次を base64 で
1つの文字列にまとめ、人間が拡張の設定画面へ貼り付ける。

```
{ code, endpoint, accessClientId, accessClientSecret }
```

`code` は 1 回限り・10 分で失効し、引き換えると installation 固有の HMAC 秘密が返る。
以後、拡張は「Access のサービストークン」と「installation 固有 HMAC」の二重で認証する。

「拡張を入れるだけでゼロ設定」は成立しない。安全なゼロ設定は存在せず、初回一度の
ペアリングは必須である。

レスポンスの `status` は `TARGET` / `NO_TARGET` / `STALE` / `AMBIGUOUS` のいずれかを必ず明示する。

HMAC は `method + path + sha256(body) + timestamp + sequence` を対象とし、replay window と
sequence 再利用拒否を持つ。CORS は認証ではないため署名は別途必要。
`installationId` は認証済みヘッダから取り、body の自己申告は採用しない。

## 6.1 コンソール（人間用 GUI）

`/browser-check/` に Worker がインラインで配信する単一ページ。Access 配下なので、
ここから到達できる操作はすべて認証済みである。

- ペアリング済みプロファイルの一覧（鮮度・ブラウザ・tab/window・最終受信）
- selector を選んで、いまエージェントが解決する対象を確認
- ペアリングコードの発行
- プロファイルの解除

`relaySecret` は Durable Object の外へ出さない。認証済みコンソールにも返さない。

デザインは DXJ Design System「白の規律」。ライトが既定で、ダークは
`localStorage('dxj-theme')` に永続する明示選択。`prefers-color-scheme` で既定を反転させない。

## 7. 権限

| Permission | 扱い |
|---|---|
| `storage` | 必須。installationId・設定・credential |
| `alarms` | 必須。heartbeat |
| `tabs` | **optional**。Agent Mode 有効化時に要求。警告は「閲覧履歴の読み取り」 |
| `<all_urls>` / `downloads` / `identity` / `identity.email` / `nativeMessaging` | 使わない |

`activeTab` は無人取得には成立しない（ユーザーの明示操作時のみ有効）。

Worker が `Access-Control-Allow-Origin: chrome-extension://<id>` を返せば host permission は不要。

## 8. データ最小化（既定値）

- URL の query と fragment を削除
- `file://` / `chrome://` / `edge://` / `brave://` / 他拡張ページは送信しない
- full URL が必要なサイトだけ allowlist
- title は独立スイッチ
- relay は installation ごと最新1件のみ、TTL は数十秒〜数分
- Worker のログに body を残さない

## 9. 保留（v0 では実装しない）

| 項目 | 保留理由 |
|---|---|
| target lease | 操作を行わないビーコン設計では保護対象が無い。`revision` を返して呼び手が再照合する |
| URL/title のエンドツーエンド暗号化 | v0 は TTL と最小化で担保。鍵配送の設計が別途必要 |
| 双方向コマンド経路 | 非目的（§0）。実装すると攻撃面が大きく変わる |
