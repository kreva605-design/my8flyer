# /verify レポート — my8flyer
日時: 2026-07-01

## サマリー
- 要件総数: 23（REQ-01〜23）
- ドリフト検出: 0件（design/architecture.md のハッシュ整合・test_report 変更なし）
- stale な要件: 0件
- 今回の変更対象: フライト確認の静的路線データ化（AviationStack廃止）

## ドリフト詳細
なし。`build-manifest.yml` の `sources.design.sha256` を更新後の architecture.md（`a9fa7b7d…`）と一致。

## 今回の変更で更新した要件
| REQ | 変更 | status |
|---|---|---|
| REQ-11 | 2モード切替を廃止（常時フライト確認に一本化） | deprecated |
| REQ-14 | フライト確認を静的 routes.json ローカル参照に置換 | green |
| REQ-16 | 7日TTLキャッシュ（API節約目的）を廃止 | deprecated |
| REQ-22 | 「API節約」→「表示整頓」トグルに意味変更 | green |
| REQ-23 | 路線データ生成 build_routes.py / routes.json 同梱（新規） | green |
| REQ-15 | 保存ルートKV同期は維持（トークン有無で判定に変更） | green |

## 受入再実行（verify_mode: auto）
- ルール検証系（REQ-01〜09, 17, 21）は今回の変更対象外（`validate()`/AWARD_RULES/ZONE ロジックは未変更）。
- 本変更のフライト確認ロジックは以下で検証済み：
  - JS構文チェック（`node --check`）: ✅ PASS
  - fetchLeg+tagFlight+ROUTE_DB のnode実データ・シミュレーション: ✅ 主要区間で★SA/🤝提携タグ正常（NRT→SIN=NH/SQ, HND→LHR=NH, SIN⇄HAN=SQ/VN 等）
- 実ブラウザでのUATはユーザー確認ステップ（本レポート後）。

## 既知の制約（architecture.md #14-6）
- 便時刻・便名なし → 乗り継ぎ時間チェックは廃止。
- 直行便のみ収載。データ未収載区間は「直行便なし」表示。
- 鮮度は upstream 週次更新＋手動再生成に依存。
