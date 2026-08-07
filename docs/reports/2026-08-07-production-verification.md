# 稼働記録 — 本番検証（2026-08-07）

> 追記型の稼働記録。設計基準は `docs/DESIGN.md`（別文書・凍結）。
> 誤りは書き換えず、訂正イベントを追記する。

## EV-1 — インストールからの疎通（04:26 UTC）

Chrome 151.0.7922.77 に unpacked で導入。ID は manifest の `key` により固定値
`happeofpndgdgdjfcgjagobkjdaanjin` で再現。コンソールの「この Chrome の拡張へ送る」から
ペアリングが成立し、`target` が `TARGET` を返した。ブラウザ種別は UA-CH から
`chrome 151.0.7922.77` と判定。

`--load-extension` フラグは Chrome 150 で無視されることを実測済み（拡張がプロファイルの
`Secure Preferences` に一切現れない）。UI からの unpacked 読み込みが唯一の経路。

## EV-2 — 欠陥: 非開示ページで heartbeat ごと停止（04:18 UTC 観測）

ブラウザが健在なのに `STALE` へ遷移。原因はアクティブタブが `chrome://newtab/` で、
`redactUrl` が拒否した際に snapshot を丸ごと捨てていたこと。**新しいタブを開いただけの
ブラウザが、閉じたブラウザと区別できない**状態だった。

修正: 住所のみ伏せ（`url`/`host`/`title` を null、`suppressed` に理由）、identity と鮮度は送る。
Incognito は明示的な opt-out なので従来どおり完全無送信。

検証: 05:36 以降の全 snapshot が `suppressed: "blocked_scheme"` を保持したまま
`TARGET` として解決された。

## EV-3 — 欠陥: heartbeat アラームが一度も発火しない（04:33 UTC 観測）

171 秒の実時間で snapshot は 1 件のみ、relay の `sequence` も厳密に +1。すなわち拡張は
1 回しか送っておらず、その 1 回も操作由来だった。

原因: `chrome.alarms.create()` は同名アラームを置換して間隔を再開する。`background.js` は
service worker の起床ごとに再実行されるため、周期内にイベントが起きるたび期限が先送りされ、
アラームは発火しなかった。

修正: `chrome.alarms.get` で存在確認してから作成。

## EV-4 — 欠陥: 不明な最終操作時刻が「今」として送られる（04:50 UTC 観測）

全 snapshot で `receivedAt - lastInteractionAt` が 720〜914 ms に固定。ネットワーク遅延そのもので、
保存値が読まれていないことを示す。`lastInteractionAt: lastInteractionAt || observedAt` の
フォールバックにより、`storage.session` が空の間（ブラウザ起動直後・拡張リロード直後）は
**全 heartbeat が「たった今使われた」と主張**していた。relay 側も欠損値を受信時刻で補っていた。

修正: `null` を端から端まで保持。resolver は最終操作時刻を知る候補を知らない候補より上位に置き、
全員が不明なときだけ到着順に落とす。

## EV-5 — 受入測定（05:36–05:41 UTC）

ページ内レコーダーで 15 秒間隔・15 回サンプリング。外部からの観測操作がタブをアクティブ化して
交絡していたため、測定をページ内へ移した（EV-5a）。

| seq | receivedAt | lastInteractionAt | 遅れ |
|---|---|---|---|
| 106 | 05:36:11 | 05:36:11 | 1s |
| 107 | 05:37:10 | 05:36:11 | 59s |
| 108 | 05:38:10 | 05:36:11 | 119s |
| 109 | 05:39:10 | 05:36:11 | 179s |
| 110 | 05:39:25 | 05:39:25 | 1s |

- heartbeat が 60 秒間隔で 3 回発火（EV-3 の修正を実証）
- その間 `lastInteractionAt` は凍結（INV-12 を実証）
- 遅れが経過時間どおり単調増加
- 実操作で 1 秒へ復帰（陽性対照。「動かない」だけでなく「動くべき時に動く」ことを同一系列で確認）

判定: **PASS**

### EV-5a — 観測系の交絡（04:26–05:00 UTC）

`lastInteractionAt` の測定が 3 回連続で不確定になった。原因は外部から JavaScript を実行して
結果を読む行為がタブをアクティブ化し、`tabs.onActivated` を発生させていたこと（最終 snapshot の
遅れが常に 1 秒だったのが指標）。ユーザー操作を疑う前に観測系を疑うべき事例。

## EV-6 — Durable Object と AMBIGUOUS の検証（2026-08-07 後半）

router テストが DO をスタブに差し替えていた穴を塞いだ。in-memory の `DurableObjectState`
（`blockConcurrencyWhile` を直列化として模す）で実クラスを動かし、実署名・実ストレージで 29 件。
`AMBIGUOUS` は DO 経由と HTTP 経由の両方で実発生させた。

変異検査を 4 パターン実施し、当初 1 件が**素通り**した。

| 変異 | 初回 | 修正後 |
|---|---|---|
| snapshot キーを installation のみに縮退 | 5 件検知 | — |
| 欠損 `lastInteractionAt` を受信時刻で補完 | 1 件検知 | — |
| installationId を body から採用 | 2 件検知 | — |
| **並行性の再チェックを削除** | **0 件（素通り）** | **2 件検知** |

素通りの原因はテスト側にあった。署名計算を `await` してからリクエストを投げていたため、revoke が
検証中ではなく**検証前**に着地し、早期の `unknown_installation` が応答していた。競合を一度も
通っていない。署名を先に済ませてからリクエストを発火する形に直し、エラー種別
（`revoked_during_verification`）まで検査して、正しい経路を通ったことを固定した。

E2E（`worker/scripts/e2e-local.mjs`、19 件）も HTTP 経路で AMBIGUOUS を確認。
「同時刻の 2 プロファイルは AMBIGUOUS」「明示 alias は曖昧でも解決する」
「窓を超えれば解消する」の 3 点。最後の 1 件は当初失敗したが、原因はテストの想定であり
製品ではない — ローカルの往復が速く、「明確に新しくした」つもりの間隔が曖昧判定の窓
（750ms）に収まっていた。AMBIGUOUS のままが正しい。待機を明示した。

## 未検証

- 複数ブラウザ間（Chrome / Edge）での `lastBrowser` 切替。ペアリング済みプロファイルが 1 件のみ。
  2026-08-07 にユーザー判断で対象外とした
- 本番環境での `AMBIGUOUS` 実発生（ローカルと DO では確認済み。本番は 1 プロファイルのため未発生）
