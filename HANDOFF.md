# My 8flyer 立て直し — HANDOFF

> **更新セッション**：`7bacf35d` ／ **2026-09-06 14:20**
> **計画の正本**：`~/.claude/plans/noble-swimming-blossom.md`（ユーザー承認済み）

---

## ① 何をしていたか

**My 8flyer（ANA特典航空券の旅程チェッカー）が一度も実利用されていない**ため、提案型へ作り直している。承認済み計画の **S-0（空席スパイク）・S-1（データ基盤）・S-2（rules-core の抽出）まで完了**、次は **S-3（proposer）**。

S-2 でやったこと：

- ルール判定を [src/rules-core.js](src/rules-core.js) へ純粋関数として切り出した（`STATE`・`alert()`・DOM 依存を除去）
- 規約の数値の正本を [data/award-rules.json](data/award-rules.json) 1箇所にし、[index.html](index.html) から写しを撤去した
- 未実装だった条文のうち「地上移動区間は両端で乗り換え1回」を実装（UI 導線は S-5）
- 「途中降機も乗り換え1回に数える」は**もともと満たしていた**ことを確認し、テストで固定した
- [tests/rules-core.test.mjs](tests/rules-core.test.mjs) 27件・[tests/browser_smoke.py](tests/browser_smoke.py) 8件を新設（全PASS）

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

---

## ③ 次の一手（最初の15分）

**S-3：proposer。** `src/proposer.js` を作る。

1. 入力 `{origin, destination, awardType, cabin, season, maxTransits, wantStopover}`
2. [routes.json](routes.json) を**スターアライアンス運航区間のみ**辿って往路・復路の経由候補を列挙（深さ上限＝往路3・復路3）
3. 探索中に第1条（目的地が旅程内で最高ゾーン）で枝刈りする
4. **候補は必ず [rules-core.js](src/rules-core.js) の `validateItinerary()` を通す**（判定を提案側に二重実装しない）
5. 検証は件数でなく**出力された旅程を1本ずつ目視**して第1〜7条を人手で検算する

呼び出し方（S-2 で確定した契約）：

```js
import { buildAwardRules, validateItinerary } from './rules-core.js';
const rules = buildAwardRules(await (await fetch('data/award-rules.json')).json());
const res = validateItinerary(itinerary, { awardType:'partner', rules, cities: CITIES });
// res.ok / res.checks[].code（'rule1' / 'transit.out.dom' / 'stopover.japan' …）
```

---

## ④ 参照ファイル

| 種別 | パス |
|---|---|
| 計画の正本 | `~/.claude/plans/noble-swimming-blossom.md` |
| **判定ロジックの正本** | [src/rules-core.js](src/rules-core.js) |
| **規約値の正本** | [data/award-rules.json](data/award-rules.json)（15値・出典と原文つき・旧版併記） |
| 単体テスト | [tests/rules-core.test.mjs](tests/rules-core.test.mjs)（`node --test tests/rules-core.test.mjs`） |
| ブラウザ疎通 | [tests/browser_smoke.py](tests/browser_smoke.py)（`.venv/bin/python tests/browser_smoke.py`・ポート8791） |
| マイルチャート | [data/mile-chart-partner.json](data/mile-chart-partner.json)（99ペア）／[data/mile-chart-ana.json](data/mile-chart-ana.json)（24ペア） |
| 取得スクリプト | `scripts/my8flyer/fetch_mile_charts.py`／`parse_award_calendar.py` |
| 空席スパイク拡張 | [spike-ana-calendar/](spike-ana-calendar/)（読み取り専用・調査用） |
| 再発防止基盤 | `scripts/scrape_guard/guard.py`／`~/.claude/commands/scrape-guard.md` |
| 設計書 | Vault `projects/my8flyer/architecture.md` **§15（S-2 の記録）** |
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

残作業 6件 — **あなたが動く必要はありません**（内訳：1番=Claudeがやる 3件 / 2番=Claudeがやる（今は待ち） 1件 / 5番=放置でよい 2件）。

| # | 判定 | やるか | 内容 | 放置するとどうなるか |
|---|---|---|---|---|
| 1 | `REQ-未達` | ✅ Claudeがやる | S-3 proposer が未着手（計画の実施順序どおり・次の一手） | 提案型にならず、白紙入力のままになる |
| 1 | `REQ-未達` | ✅ Claudeがやる | 地上移動フラグを画面から立てる導線が無い（判定側は実装済み・S-5 の画面作り直しで追加） | 羽田着→成田発のような旅程を、乗り換え2回として過剰に不合格にし続ける |
| 1 | `REQ-未達` | ✅ Claudeがやる | `MILE_CHART`（旧チャート）が index.html に残置。S-1 で取得した Zone 1-A/1-B の2チャートに差し替えるのは S-5 | 周遊旅程に対して必要マイルを過小表示し続ける（1-B が正・最大 +17,000 マイル） |
| 2 | `REQ-待ち` | ⏸ Claudeがやる（今は待ち） | `build-manifest.yml` の `sources.design.sha256` を確定できない。`hash_sources.py` が**参照欠損46件**で停止するが、これは既知の誤検出（**TASK-DF-09**・Vault のファイルを bare filename で参照している／カンマ区切りの複数パスを1パスとして解決する）。**解除条件＝TASK-DF-09 の完了** | 設計書を更新するたび `/verify` が drift を出し続ける（検知は生きているので実害は「毎回同じ差分が出る」だけ） |
| 5 | `要件外-任意` | 💤 放置でよい | `data/award-rules.json` は片道旅程の値も持つが、アプリは往復しか組めないため未使用（要件に無い・Claudeの気づき） | **何も起きない** |
| 5 | `要件外-任意` | 💤 放置でよい | 都市マスタが66都市で、経由候補7都市が未登録（SFO・EWR・IAD・IAH・AKL・YYZ・MAJ）（要件に無い・Claudeの気づき） | 提案の経由候補が少し狭いままになる。S-3 の実測後に必要なら足せばよい |

### そのほか未解決（S-3 以降の判断材料）

| # | 内容 |
|---|---|
| 1 | ANA自社便は日本発の途中降機ができないため、**8flyer の周遊は実質 提携特典専用**の可能性。`ana` モードで周遊UIを出す是非は S-5 の画面設計で決める |
| 2 | 特典カレンダーの △（残席わずか）が1人で実際に取れるかは未検証。空席検索で確定するしかない |
| 3 | 提携社便（United等）の空席はカレンダーに出ない。seats.aero か空席検索でしか見えない |
| 4 | Jonty/airline-route-data は **2026-05-10 から17週連続で取得失敗**（上流の flightsfrom.com が403）。路線グラフは 2026-05-03 で凍結中。S-3 はこの凍結データで動かす |
