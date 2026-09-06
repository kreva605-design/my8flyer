# My 8flyer 立て直し — HANDOFF

> **更新セッション**：`7bacf35d` ／ **2026-09-07**
> **計画の正本**：`~/.claude/plans/noble-swimming-blossom.md`（ユーザー承認済み）

---

## ① 何をしていたか

**My 8flyer（ANA特典航空券の旅程チェッカー）が一度も実利用されていない**ため、提案型へ作り直している。承認済み計画の **S-0・S-1・S-2・S-3 完了**。**順序を変更し、S-5（UI）→ S-4（実便）の順で進める**（2026-09-06 ユーザー決定）。

**いまは S-5 の画面設計をユーザーとレビュー中。第3版まで提出済み。設計承認が実装の必須ゲートなので、承認が出るまで画面の実装に入らない。**

> 📄 画面設計（第3版）：https://claude.ai/code/artifact/580d31c6-d0c5-42ea-aaaa-9f3b8b64578a

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

S-5 のレビューで見つけて直したこと（2026-09-06〜07）：

- 🔴 **【欠陥】特典の種類で運航会社を絞っていなかった。** ANA自社便の提案28本中4本に、ANAが飛ばない区間が入っていた（羽田→グアムはUAのみ運航）。`data/airlines.json` を正本にして是正。副産物として提携社の114区間が候補に加わり、羽田→ハノイの基準が 38,000→**35,000** に
- **必要マイルの説明を訂正。** 「一律+7,000」はパリ限定だった。正しくは**目的地のゾーンで +3,000〜+7,000**、寄り道先のゾーンは無関係。**ANA自社便は 1-A/1-B が無いので追加0**（ただし日本発の途中降機は不可＝帰着地変更のみ）
- **順位付けを距離で行う。** `data/airports.json`（OurAirports）＋ `src/geo.js`。「まっすぐ帰る旅程との飛行距離の差」で並べる
- **「増える都市」を1本の軸に。** 寄り道と帰着地変更を掛け算すると560行になる
- **総当たりをやめた。** 24.6秒 → 0.4〜0.7秒（メモリ枯渇で落ちてもいた）

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

**ユーザーの回答待ち。3問が未回答で、うち Q5 は編集導線の設計に直結する。**

| | 未回答の質問 |
|---|---|
| **Q5** | S2・S3・S4 の画面から「直したい」と思う値はあるか（配置ポリシー §5 の必須ヒアリング） |
| Q9 | 国内の帰着地は就航8路線以上に限定。絞る／広げる希望はあるか |
| Q10 | 「その国の都市をできるだけ選ぶ」の意味（①同じ国は1都市に畳む ②各国の代表都市を優先） |

**回答が来たら、画面設計を第4版に更新 → 承認 → 実装（`/build`）。**

提案の中身を自分の目で見るには：

```bash
cd projects/my8flyer
node tests/propose_cli.mjs HND CDG --stopover --top 12   # 羽田→パリ（34本）
node tests/propose_cli.mjs HND HAN --stopover            # 羽田→ハノイ（+3,000で1都市）
node tests/propose_cli.mjs HND CDG --ana --stopover      # ANA自社便（帰着地変更のみ・追加0）
```

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
| 距離（しんどさ） | [src/geo.js](src/geo.js)／[data/airports.json](data/airports.json)（OurAirports・public domain） |
| **乗れる航空会社の正本** | [data/airlines.json](data/airlines.json)（自社便=NH／提携=スタアラ∪ANA提携社）★一次情報との突合は未実施 |
| 提案の目視CLI | [tests/propose_cli.mjs](tests/propose_cli.mjs)（`node tests/propose_cli.mjs HIJ CDG --stopover`） |
| **規約値の正本** | [data/award-rules.json](data/award-rules.json)（15値・出典と原文つき・旧版併記） |
| 単体テスト | [tests/rules-core.test.mjs](tests/rules-core.test.mjs) 27件／[tests/proposer.test.mjs](tests/proposer.test.mjs) 31件 |
| ブラウザ疎通 | [tests/browser_smoke.py](tests/browser_smoke.py)（`.venv/bin/python tests/browser_smoke.py`・ポート8791） |
| マイルチャート | [data/mile-chart-partner.json](data/mile-chart-partner.json)（99ペア）／[data/mile-chart-ana.json](data/mile-chart-ana.json)（24ペア） |
| 取得スクリプト | `scripts/my8flyer/fetch_mile_charts.py`／`parse_award_calendar.py` |
| 空席スパイク拡張 | [spike-ana-calendar/](spike-ana-calendar/)（読み取り専用・調査用） |
| 再発防止基盤 | `scripts/scrape_guard/guard.py`／`~/.claude/commands/scrape-guard.md` |
| 設計書 | Vault `projects/my8flyer/architecture.md` **§15（S-2）・§16（S-3）・§17（S-5設計と是正）** |
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

残作業 8件 — **あなたの回答が3件あります**（内訳：**3番=あなたがやる 3件** / 1番=Claudeがやる 3件 / 2番=Claudeがやる（今は待ち） 1件 / 5番=放置でよい 1件）。

| # | 判定 | やるか | 内容 | 放置するとどうなるか |
|---|---|---|---|---|
| 3 | `REQ-人手` | 👤 **あなたがやる** | **Q5：各画面から「直したい」値はあるか。** 配置ポリシー §5 で必須のヒアリング | 編集導線が決められず、S-5 の実装に入れない |
| 3 | `REQ-人手` | 👤 **あなたがやる** | **Q9：国内の帰着地の範囲**（いま就航8路線以上） | 現状の設定のまま実装する |
| 3 | `REQ-人手` | 👤 **あなたがやる** | **Q10：「その国の都市」の意味**（同国を1都市に畳む／代表都市を優先） | 就航路線数の多い順のまま実装する |
| 1 | `REQ-未達` | ✅ Claudeがやる | S-5 の実装（proposer / miles-core を画面へ接続）。**設計承認が必須ゲート**なので着手していない | 提案エンジンはCLIからしか使えず、実利用に届かない |
| 1 | `REQ-未達` | ✅ Claudeがやる | 陸路移動フラグを画面から立てる導線（判定側は実装済み・S-5） | 羽田着→成田発を乗り換え2回として過剰に不合格にし続ける |
| 1 | `REQ-未達` | ✅ Claudeがやる | 旧 `MILE_CHART` の残置。画面表示を miles-core へ差し替え（S-5） | 画面のマイル表示だけが公式と46セル中22セル食い違ったまま |
| 2 | `REQ-待ち` | ⏸ Claudeがやる（今は待ち） | manifest の `sources.design.sha256` 確定。**解除条件＝TASK-DF-09 の完了**（参照欠損の誤検出） | 設計書を更新するたび `/verify` が同じ drift を出す |
| 4 | `要件外-リスク` | ❓ 決めてほしい | **`data/airlines.json` が一次情報と未突合。** index.html から移設しただけで、ANA公式の提携航空会社ページと照合していない（要件に無い・Claudeの気づき） | 提携社が増減したときに、乗れない便を提案する／乗れる便を落とす。**費用¥0・所要30分程度。`/scrape-guard` を通して突合する。Claude の推奨は「実装前にやる」** |

### そのほか未解決（S-3 以降の判断材料）

| # | 内容 |
|---|---|
| 1 | ANA自社便は日本発の途中降機ができないため、**8flyer の周遊は実質 提携特典専用**の可能性。`ana` モードで周遊UIを出す是非は S-5 の画面設計で決める |
| 2 | 特典カレンダーの △（残席わずか）が1人で実際に取れるかは未検証。空席検索で確定するしかない |
| 3 | 提携社便（United等）の空席はカレンダーに出ない。seats.aero か空席検索でしか見えない |
| 4 | Jonty/airline-route-data は **2026-05-10 から17週連続で取得失敗**（上流の flightsfrom.com が403）。路線グラフは 2026-05-03 で凍結中。S-3 はこの凍結データで動かす |
