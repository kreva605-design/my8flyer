# My 8flyer 立て直し — HANDOFF

> **更新セッション**：`137dd9f3` ／ **2026-09-07**
> **計画の正本**：`~/.claude/plans/noble-swimming-blossom.md`（ユーザー承認済み）

---

## ① 何をしていたか

**My 8flyer（ANA特典航空券の旅程チェッカー）が一度も実利用されていない**ため、提案型へ作り直している。承認済み計画の **S-0・S-1・S-2・S-3・S-5 完了**（順序変更で S-5（UI）→ S-4（実便）の順・2026-09-06 ユーザー決定）。

**2026-09-07：画面設計 第5版がユーザー承認され、S-5 の実装まで完了した。** 未デプロイ（下記③）。

> 📄 画面設計 第6版＝実装後の記録：https://claude.ai/code/artifact/580d31c6-d0c5-42ea-aaaa-9f3b8b64578a

この日にやったこと：

- 🔴 **【欠陥】「自宅で途中降機して、国内線1区間を国際線と別の日に飛ぶ」旅程を一覧から機械的に捨てていた。** 規約判定は通っていて候補も 2,752 通り生成されていたのに、同じ都市の中から**総飛行距離が最短の1本**だけを代表にしていたため、遠回りになる自宅経由が毎回消えていた（[proposer.js](src/proposer.js) の `keep` キーが `マイル|都市` だった）→ **キーに行き方を含める**形に是正
- **往路版も作った**（ユーザー指摘）。途中降機は往路・復路のどちらにも置ける（ANA公式の例示で確認）。復路版＝帰ってからあとで飛ぶ／往路版＝先に飛んでおく
- **提案画面（さがす→候補→旅程）を実装**。[index.html](index.html) から proposer / miles-core を呼び、選んだ旅程を従来の判定UIへ引き渡す
- **陸路移動の導線**を画面に追加（判定側は前からあったが立てる場所が無かった）
- **旧 `MILE_CHART` を撤去**し、必要マイルを miles-core ＋公式チャートへ一本化。**旧表は14セル中8セルが公式と食い違っていた**（羽田→パリ ビジネス 旧140,000／公式115,000）
- **規約値を4つ追加**（`/scrape-guard` で一次情報から取得）：途中降機は往路・復路いずれか1回／有効期間は旅行開始日から1年（＝「後日に飛ぶ」の上限）／旧版の「日本発・海外発ともに可」の明文
- 検証：**単体 73/73・画面 26/26（従来UI 14＋提案フロー 12）PASS**。提案は 0.2〜0.7秒

それ以前（S-2・S-3・第4版までの是正）の経緯は Vault `projects/my8flyer/architecture.md` §15〜§20 にある。

---

## ② 決定事項

| 日付 | 決定 |
|---|---|
| 09-02 | 本家「お得トラベル」の有料メンバーシップ（月1,290円）には**課金せず、自作・¥0** |
| 09-02 | 提案の入口は「**目的地を選ぶ → ルート提案**」／出発地は毎回選択／ANAへは**半自動**（人の操作ペース） |
| 09-03 | 実便データは **fast-flights（Google Flights）を採用** |
| 09-05 | 空席は**2段構え**＝面を特典カレンダー（1回で180日分）／点を空席検索で確定 |
| 09-06 | **保有マイルは設計に埋め込まない。**任意の入力欄でフィルタとしてだけ使う |
| 09-06 | アプリの本質は「同じマイルで、もう1都市」＝**寄り道1回をどこに使うかの提案** |
| 09-06 | **規約値が読めないときは判定を止める**（既定値で「問題ありません」を出さない）。fail-safe は必ず厳しい側へ |
| 09-07 | 「もう1都市」への行き方は **3通り**（🛬 帰着地変更／✈️ 寄り道／🏠 自宅で途中降機）。**一覧の行は都市ごと**にし、行き方は行の中に並べる |
| 09-07 | Q9＝**帰着地は就航8路線以上のまま**（現状維持）。この線引きは帰着地にだけ掛かり、寄り道には掛からない（松山＝5路線も ✈️ には出る） |
| 09-07 | Q10＝**海外は同じ国で1行に畳む／国内は都市ごとに残す** |
| 09-07 | Q5＝直せるのは**出発地（S2）と寄り道先（S3）**。座席クラス・特典の種類は S1 のまま |
| 09-07 | Q11＝**同じ国を1行に畳むのは海外だけ**。国内は都市ごとに残す（畳むと帰着地を選ぶ行為が消えるため） |
| 09-07 | Q12＝**「後日に飛ぶ」の上限は券の有効期間（旅行開始日から1年）**。途中降機に固有の日数上限は現行版に記載なし。海外側の滞在日数（ビザ）は本アプリの対象外 |
| 09-07 | **自宅で途中降機は往路・復路の両方で提案する**（ユーザー指摘。ANA公式の例示「往路・復路いずれか1回」で裏取り） |

---

## ③ 次の一手（最初の15分）

**実装は終わっている。次は「公開するかどうか」の判断だけ。**

my8flyer は `~/.claude/docs/infra-inventory.md` §2.1 で **B層（承認必須）**（GitHub Pages が無認証で第三者に届くため）。**ユーザーの承認が出たら**次を実行する：

```bash
cd projects/my8flyer
git add -A
git commit -m "feat: 自宅で途中降機して国内線をずらす提案と、提案画面（S-5）"
git push          # → https://kreva605-design.github.io/my8flyer/ に反映
```

出す前に確認済みのこと：単体 73/73・画面 26/26 PASS ／ `data/snapshots/*.html`（他社ページ全文）は `.gitignore` 済み ／ 巻き戻しは `git revert` で可能。

**公開後にやること：** 実機（スマホ）で「羽田→パリ」を出し、🏠 の行が見えることと、1.1MB の `routes.json` の読み込みが待てる速さかを目視する。遅ければ路線データの圧縮を検討する（未着手）。

次の工程は **S-4（実便の裏どり・fast-flights）**。計画の正本 `~/.claude/plans/noble-swimming-blossom.md` を参照。

提案の中身を目で見るには：

```bash
cd projects/my8flyer
node tests/propose_cli.mjs HND CDG --stopover --top 14   # 🏠 は「自宅で途中降機」と表示される
node --test tests/*.test.mjs                              # 73件
.venv/bin/python tests/browser_propose.py                 # 提案画面 12件
.venv/bin/python tests/browser_smoke.py                   # 従来UI・陸路・マイル表示 14件
```

---

## ④ 参照ファイル

| 種別 | パス |
|---|---|
| 計画の正本 | `~/.claude/plans/noble-swimming-blossom.md` |
| **判定ロジックの正本** | [src/rules-core.js](src/rules-core.js) |
| **必要マイルの正本** | [src/miles-core.js](src/miles-core.js)（1-A/1-B 判定・オープンジョー合算） |
| **提案エンジン** | [src/proposer.js](src/proposer.js) |
| 距離（しんどさ） | [src/geo.js](src/geo.js)／[data/airports.json](data/airports.json)（OurAirports・public domain） |
| **乗れる航空会社の正本** | [data/airlines.json](data/airlines.json)（27社＋提携9社・**突合済み**）。取得＝`scripts/my8flyer/fetch_airlines.py`・**次回見直し 2027-03-06**・履歴は [data/airlines-history/](data/airlines-history/) |
| 提案の目視CLI | [tests/propose_cli.mjs](tests/propose_cli.mjs)（`node tests/propose_cli.mjs HIJ CDG --stopover`） |
| **規約値の正本** | [data/award-rules.json](data/award-rules.json)（15値・出典と原文つき・旧版併記） |
| 単体テスト | [tests/rules-core.test.mjs](tests/rules-core.test.mjs) 27件／[tests/proposer.test.mjs](tests/proposer.test.mjs) 40件 |
| ブラウザ疎通 | [tests/browser_smoke.py](tests/browser_smoke.py)（`.venv/bin/python tests/browser_smoke.py`・ポート8791） |
| マイルチャート | [data/mile-chart-partner.json](data/mile-chart-partner.json)（99ペア）／[data/mile-chart-ana.json](data/mile-chart-ana.json)（24ペア） |
| 取得スクリプト | `scripts/my8flyer/fetch_mile_charts.py`／`parse_award_calendar.py` |
| 空席スパイク拡張 | [spike-ana-calendar/](spike-ana-calendar/)（読み取り専用・調査用） |
| 再発防止基盤 | `scripts/scrape_guard/guard.py`／`~/.claude/commands/scrape-guard.md` |
| 設計書 | Vault `projects/my8flyer/architecture.md` **§15〜§19**（§19＝航空会社の一次情報化と特典種別の可視化） |
| 公開ページ | https://kreva605-design.github.io/my8flyer/ |

---

## ⑤ 未解決・ハマりどころ

### 🔴 最重要のハマりどころ

**ANAの規約ページは1つのURLに新旧2版がタブで同居し、`aria-selected="true"` が付くのは古い版のほう。** 上から読むと旧版を拾う。**2026-09-06 にこれで2回続けて誤読した**。

→ **ANAの条文を引くときは必ず `/scrape-guard` を通し、`locator`（パネル名）を記録すること。**

### 確定した規約（現行版・2025-06-24以降）

| | ANA自社便 | 提携航空会社 |
|---|---|---|
| 国内乗り換え | 往路・復路**各1回** | 往路・復路**各1回** |
| 海外乗り換え | **0回**（規定なし） | 往路・復路各2回 |
| 途中降機 | **日本発は不可** | **旅程全体で1回** |

これらは [data/award-rules.json](data/award-rules.json) から読まれ、[tests/rules-core.test.mjs](tests/rules-core.test.mjs) の「現行版の規約値を採る（旧版を拾わない）」で固定されている。

### 残作業

残作業 4件 — **あなたの判断が1件あります**（内訳：3番=あなたがやる 1件 / 2番=Claudeがやる（今は待ち） 1件 / 5番=放置でよい 2件）。

| # | 判定 | やるか | 内容 | 放置するとどうなるか |
|---|---|---|---|---|
| 3 | `REQ-人手` | 👤 **あなたがやる** | **公開の承認**（my8flyer は B層＝無認証で第三者に届くため）。承認が出れば `git push` は数十秒 | 実装は手元にあるが、スマホから使えないまま |
| 2 | `REQ-待ち` | ⏸ Claudeがやる（今は待ち） | manifest の `sources.design.sha256` 確定。**解除条件＝TASK-DF-09 の完了**（`/verify` の参照欠損の誤検出） | 設計書を更新するたび `/verify` が同じ drift を出す |
| 5 | `要件外-任意` | 💤 放置でよい | `routes.json` が 1.1MB あり、提案の初回だけ読み込みが要る（**要件に無い・Claudeの気づき**）。実測では手元で 0.2〜0.7秒 | **何も起きない**（実機で待てなければそのとき考える） |
| 5 | `要件外-任意` | 💤 放置でよい | `data/snapshots/` に同じページの別名スナップショットが2組ある（`usage`/`ana-tk-usage` 等。**要件に無い・Claudeの気づき**）。いずれも `.gitignore` 済みで公開されない | **何も起きない**（ローカルの容量を 1.5MB 使うだけ） |

### そのほか未解決（S-3 以降の判断材料）

| # | 内容 |
|---|---|
| 1 | ANA自社便は日本発の途中降機ができないため、**8flyer の周遊は実質 提携特典専用**の可能性。`ana` モードで周遊UIを出す是非は S-5 の画面設計で決める |
| 2 | 特典カレンダーの △（残席わずか）が1人で実際に取れるかは未検証。空席検索で確定するしかない |
| 3 | 提携社便（United等）の空席はカレンダーに出ない。seats.aero か空席検索でしか見えない |
| 4 | Jonty/airline-route-data は **2026-05-10 から17週連続で取得失敗**（上流の flightsfrom.com が403）。路線グラフは 2026-05-03 で凍結中。S-3 はこの凍結データで動かす |
