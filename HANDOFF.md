# My 8flyer 立て直し — HANDOFF

> **更新セッション**：`7bacf35d` ／ **2026-09-06 16:40**
> **計画の正本**：`~/.claude/plans/noble-swimming-blossom.md`（ユーザー承認済み）

---

## ① 何をしていたか

**My 8flyer（ANA特典航空券の旅程チェッカー）が一度も実利用されていない**ため、提案型へ作り直している。承認済み計画の **S-0（空席スパイク）・S-1（データ基盤）・S-2（rules-core の抽出）・S-3（proposer）まで完了**、次は **S-4（実便の裏どり）** または **S-5（UI 作り直し）**。

S-2 でやったこと：

- ルール判定を [src/rules-core.js](src/rules-core.js) へ純粋関数として切り出した（`STATE`・`alert()`・DOM 依存を除去）
- 規約の数値の正本を [data/award-rules.json](data/award-rules.json) 1箇所にし、[index.html](index.html) から写しを撤去した
- 「地上移動区間は両端で乗り換え1回」を実装（UI 導線は S-5）／「途中降機も乗り換え1回」は元から満たしていたためテストで固定
- **公開ページへ反映済み**（承認を得て push・実測 6/6 PASS）

S-3 でやったこと：

- [src/miles-core.js](src/miles-core.js)：公式チャート2本から必要マイルを出す。日本の **Zone 1-A / 1-B** を判定（周遊は原則 1-B＝+7,000マイル）
- [src/proposer.js](src/proposer.js)：路線グラフを辿って候補を列挙 →**判定は必ず rules-core へ委ねる**→ マイル順に並べる
- 「必要マイル × 寄り道先」で集約。**広島→パリ 420,234通り → 28本**にした
- [tests/proposer.test.mjs](tests/proposer.test.mjs) 20件を新設（単体は計47件・全PASS）
- ⚠️ **proposer / miles-core はまだ画面から呼ばれていない**（S-5 で接続）

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

**まず提案の中身を自分の目で見る。** これが次の判断の材料になる。

```bash
cd projects/my8flyer
node tests/propose_cli.mjs HIJ CDG --stopover --top 20     # 広島→パリ・寄り道あり
node tests/propose_cli.mjs HND CMN --stopover              # 東京→カサブランカ（Zone8）
node tests/propose_cli.mjs HIJ CDG --ana                   # ANA自社便（1本しか出ない）
```

そのうえで **S-4（実便の裏どり）** と **S-5（UI 作り直し）** のどちらを先にやるかを決める。
**S-5 を先にする案を推す。** 提案そのものは実便が無くても成立しており（L1 で自立）、
いま足りないのは「28本をどう見せて1本を選ばせるか」のほうであるため。
S-5 は `/ui-flow` → **★PoC是非判定（ユーザー承認）** が必須。

呼び出し方（S-2・S-3 で確定した契約）：

```js
import { buildAwardRules, validateItinerary } from './rules-core.js';
import { buildGraph, propose } from './proposer.js';

const rules = buildAwardRules(await (await fetch('data/award-rules.json')).json());
const graph = buildGraph(routesJson, CITIES, { carriers: STAR_ALLIANCE });
const { proposals, stats } = propose(
  { origin:'HIJ', destination:'CDG', awardType:'partner', cabin:'eco', wantStopover:true },
  { rules, charts:{partner, ana}, cities: CITIES, graph });
// proposals[] = { itinerary, miles, milesNote, transits, stopover, stopoverName, route[], variants, warnings[] }
```

---

## ④ 参照ファイル

| 種別 | パス |
|---|---|
| 計画の正本 | `~/.claude/plans/noble-swimming-blossom.md` |
| **判定ロジックの正本** | [src/rules-core.js](src/rules-core.js) |
| **必要マイルの正本** | [src/miles-core.js](src/miles-core.js)（1-A/1-B 判定・オープンジョー合算） |
| **提案エンジン** | [src/proposer.js](src/proposer.js) |
| 提案の目視CLI | [tests/propose_cli.mjs](tests/propose_cli.mjs)（`node tests/propose_cli.mjs HIJ CDG --stopover`） |
| **規約値の正本** | [data/award-rules.json](data/award-rules.json)（15値・出典と原文つき・旧版併記） |
| 単体テスト | [tests/rules-core.test.mjs](tests/rules-core.test.mjs) 27件／[tests/proposer.test.mjs](tests/proposer.test.mjs) 20件 |
| ブラウザ疎通 | [tests/browser_smoke.py](tests/browser_smoke.py)（`.venv/bin/python tests/browser_smoke.py`・ポート8791） |
| マイルチャート | [data/mile-chart-partner.json](data/mile-chart-partner.json)（99ペア）／[data/mile-chart-ana.json](data/mile-chart-ana.json)（24ペア） |
| 取得スクリプト | `scripts/my8flyer/fetch_mile_charts.py`／`parse_award_calendar.py` |
| 空席スパイク拡張 | [spike-ana-calendar/](spike-ana-calendar/)（読み取り専用・調査用） |
| 再発防止基盤 | `scripts/scrape_guard/guard.py`／`~/.claude/commands/scrape-guard.md` |
| 設計書 | Vault `projects/my8flyer/architecture.md` **§15（S-2）・§16（S-3）** |
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

残作業 7件 — **あなたの判断が1件あります**（内訳：1番=Claudeがやる 3件 / 2番=Claudeがやる（今は待ち） 1件 / **4番=決めてほしい 1件** / 5番=放置でよい 2件）。

| # | 判定 | やるか | 内容 | 放置するとどうなるか |
|---|---|---|---|---|
| 4 | `要件外-リスク` | ❓ 決めてほしい | **S-4（実便の裏どり）と S-5（UI 作り直し）のどちらを先にやるか。** 計画の順序は S-4 → S-5 だが、提案は実便が無くても成立しており、いま足りないのは「28本をどう見せて1本を選ばせるか」のほう。**Claude の推奨は S-5 を先**（要件に無い順序変更・Claudeの気づき） | 計画どおり S-4 を先に進める。実便は付くが、28本を選べる画面が無いままなので実利用にはまだ届かない |
| 1 | `REQ-未達` | ✅ Claudeがやる | proposer / miles-core が画面から呼ばれていない（S-5 で接続） | 提案エンジンはあるがCLIからしか使えない＝実利用できない |
| 1 | `REQ-未達` | ✅ Claudeがやる | 地上移動フラグを画面から立てる導線が無い（判定側は実装済み・S-5） | 羽田着→成田発を乗り換え2回として過剰に不合格にし続ける |
| 1 | `REQ-未達` | ✅ Claudeがやる | 旧 `MILE_CHART` が index.html に残置。表示を miles-core へ差し替えるのは S-5 | 画面の必要マイル表示だけが公式と46セル中22セル不一致のまま（提案側は新チャートを使用） |
| 2 | `REQ-待ち` | ⏸ Claudeがやる（今は待ち） | `build-manifest.yml` の `sources.design.sha256` を確定できない。`hash_sources.py` が参照欠損46件で停止するが、これは既知の誤検出（**TASK-DF-09**）。**解除条件＝TASK-DF-09 の完了** | 設計書を更新するたび `/verify` が同じ drift を出す（検知は生きている） |
| 5 | `要件外-任意` | 💤 放置でよい | 路線グラフが 2026-05-03 で凍結（上流の flightsfrom.com が403で17週連続失敗）（要件に無い・Claudeの気づき） | 新規就航・運休が提案に反映されない。**当面は何も起きない**（既存路線は変わらないため） |
| 5 | `要件外-任意` | 💤 放置でよい | 都市マスタが66都市で、経由候補7都市が未登録（SFO・EWR・IAD・IAH・AKL・YYZ・MAJ）（要件に無い・Claudeの気づき） | 提案の経由候補が少し狭いまま。S-5 の実利用後に必要なら足せばよい |

### そのほか未解決（S-3 以降の判断材料）

| # | 内容 |
|---|---|
| 1 | ANA自社便は日本発の途中降機ができないため、**8flyer の周遊は実質 提携特典専用**の可能性。`ana` モードで周遊UIを出す是非は S-5 の画面設計で決める |
| 2 | 特典カレンダーの △（残席わずか）が1人で実際に取れるかは未検証。空席検索で確定するしかない |
| 3 | 提携社便（United等）の空席はカレンダーに出ない。seats.aero か空席検索でしか見えない |
| 4 | Jonty/airline-route-data は **2026-05-10 から17週連続で取得失敗**（上流の flightsfrom.com が403）。路線グラフは 2026-05-03 で凍結中。S-3 はこの凍結データで動かす |
