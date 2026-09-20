# /verify レポート — my8flyer
日時: 2026-09-19

対象の変更：**「特典の種類」を3つに分ける（REQ-88・89）／グループ空港が路線グラフから外れていた不具合の是正（REQ-90）**

## サマリー

| 項目 | 値 |
|---|---|
| 要件総数 | 90（今回 +3） |
| errors | 0 |
| missing_sources | 0 |
| unmapped_drift | 0 |
| ドリフト検出 | 1件（`design` = Vault `architecture.md`。今回 §24 を**追記**したため） |
| stale 判定 | 90件（ドリフト元が `design` のため機械的に全件へ波及） |
| 参照欠損（reference_issues） | 233件（**既知の誤検出**・後述） |

## ドリフト詳細

| source | old_sha256 | new_sha256 |
|---|---|---|
| design | a9fa7b7d… | 2852e40c… |

**中身の判定：** 今回の編集は `architecture.md` への**追記のみ**（§24 を末尾に追加）で、
§8-2・§17・§18 など既存要件が参照している節は1文字も変えていない。
したがって REQ-01〜87 の設計参照は実質的に無効化されておらず、`status` は据え置いた。
**ハッシュのベースライン確定は行っていない**（理由は下の「ハッシュ未確定の理由」）。

## 受入再実行結果

| 対象 | 実行手段 | 結果 |
|---|---|---|
| 単体（rules-core / miles-core / proposer / combos / award-calendar） | `node --test tests/*.test.mjs` | ✅ **107/107 PASS**（変更前と同数） |
| 提案画面 S1〜S3 | `tests/browser_propose.py`（Playwright） | ✅ **44/44 PASS**（今回の検査12件を追加） |
| 判定UI全体 | `tests/browser_smoke.py` | ✅ 15/15 PASS |
| 便の組み合わせ | `tests/browser_combos.py` | ✅ 24/24 PASS |
| 日付・拡張連携 | `tests/browser_dates.py` | ✅ 30/30 PASS |
| 特典カレンダー取り込み | `tests/browser_seats.py` | ✅ 20/20 PASS |

### 今回の要件の実測（REQ-88〜90）

| 検査 | 実測値 |
|---|---|
| 提携航空会社→ベトナム航空で旅程が出る | `62,000マイル`／往路 東京（羽田 / 成田）→ ハノイ → アムステルダム／復路 その逆 |
| 全区間が指定した1社か | `['VN']`（他社0） |
| 他社の案が混ざらないか | 混入 0本 |
| 提携社の一覧が `data/airlines.json` 由来か | `['', 'EN','NX','EY','EW','OA','PR','VS','VN','VA']`（スタアラ加盟社 `UA` は出ない） |
| グループ空港（TYO）発で基準の旅程が作れる | 作れる（以前は「作れませんでした」・27行） |
| グループ空港を乗り継ぎ地に使っていないか | 0本 |

## 参照欠損 233件の扱い（既知の誤検出・TASK-DF-09）

内訳は `missing_file` 127件・`unset` 106件で、**既存87要件と同じ形**。

- `architecture.md`（90件）… 正本は Vault 側で、`sources.design.path` に正しく登録されている。
  `diff_report.py` が `design_ref` をプロジェクト直下からのパスとして解決するために出る誤検出
- `test_report_2026-05-20_phase11.md`（11件）… 同じ理由
- `tests/*.mjs,tests/*.py`（複数）… カンマ区切りの複数参照を1つのパスとして解決するために出る誤検出。
  **個々のファイルはすべて実在する**（今回追加した REQ-88〜90 の `test_ref` も両ファイルとも実在・実行済み）
- `unset` 106件 … `spec_ref` 未設定。本プロジェクトは仕様書を持たず設計書に統合している

この不一致は `/verify` 側の既知課題として起票済み（TASK-DF-09）。**今回の変更が新たに作った参照欠損はない。**

## ハッシュ未確定の理由

`--update-hashes` の機械ガード条件②（参照欠損 0）を満たせないため、**ベースライン確定は行わない**
（TASK-DF-09 が解消されるまで確定不可という既存方針どおり）。
`hash_sources.py --check` で差分が `design` 1件であることのみ確認した。

## 検査基盤

| 項目 | 結果 |
|---|---|
| manifest schema（ルートmapping・sources・id一意） | ✅（YAML パース・90件・ID重複なし） |
| missing_sources | ✅ 0件 |
| unmapped_drift | ✅ 0件 |
| ACL差異 | ✅ なし（今回の変更は画面とローカル計算のみ。外部送信・権限の追加なし） |

## 次のアクション

- `/cleanup`（管理ドキュメントへの反映検査）
- **GitHub Pages への反映は未実施**（A層＝ユーザー判断で実行可）
