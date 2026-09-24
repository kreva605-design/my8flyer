# /verify レポート — my8flyer
日時: 2026-09-24 15:05 JST（曜日を考慮した提案 REQ-104〜106 の反映後）

## サマリー
- 要件総数: **106**（REQ-104〜106 を新規登録）
- green: **95** / yellow: 9 / deprecated: 2 / red: 0 / stale: **0**
- 抜け（要件正本にあるが manifest 未登録）: 0件 ※本プロジェクトは overview を持たず、正本は Vault `architecture.md`
- ドリフト検出: 1件 → **追従を確認のうえ新しいベースラインを確定**（下記）

## ドリフト詳細

| source | old_sha256 | new_sha256 | 扱い |
|---|---|---|---|
| design（`architecture.md`） | `9649d95e…` | `aa1482df…` | §29 の見出しを「実装済み」に直し §29-6 を追記。実装・テスト・manifest が同じ作業内で追従済みのため確定 |

確定コマンドの `--baseline-note` に根拠を記録済み（manifest 冒頭「ハッシュ確定の根拠」欄）。

## stale な要件

なし（ベースライン確定後 0件）。

## 受入再実行結果（verify_mode: auto）

| REQ | 実行手段 | 結果 |
|---|---|---|
| REQ-104 | `node --test tests/weekdays.test.mjs` | ✅ PASS（22/22） |
| REQ-105 | Playwright `tests/browser_propose.py` | ✅ PASS（曜日の検査 うち5件） |
| REQ-106 | Playwright `tests/browser_propose.py` | ✅ PASS（注記の検査 1件） |
| 既存要件（回帰） | 単体・画面の全スイート | ✅ 単体129/129・提案87/87・実便19/19・smoke15/15・combos24/24・dates30/30・seats20/20 |

## 検査基盤・参照エラー

| 項目 | 結果 |
|---|---|
| manifest schema | ✅ |
| missing_sources | 0件 |
| unmapped_drift | 0件 |
| 参照欠損（ファイルが実在しない） | **0件** |
| 参照未設定（`spec_ref`） | 122件 ※本プロジェクトは仕様書を作らず設計書に集約する運用。機械ガードの対象外 |
| ACL差異 | なし（本作業に権限追加・外部送信・課金なし） |

### `::シンボル` の手動確認（`/verify` は見ないため）

| 参照 | 実在 |
|---|---|
| `src/proposer.js::legWeekdays` | ✅ 701行 |
| `src/proposer.js::itineraryWeekdays` | ✅ 741行 |
| `src/proposer.js::propose` | ✅ 307行 |
| `index.html::ppRender` / `::ppClearWday` / `::ppWeekLabel` | ✅ 4件すべて実在 |

## 次のアクション

- PASS のため直後工程は `/cleanup`
- 本番反映（GitHub Pages への push）は **B層＝ユーザー承認が必要**
