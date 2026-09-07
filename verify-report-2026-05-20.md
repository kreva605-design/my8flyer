# /verify レポート — my8flyer

日時: 2026-05-20（初回ベースライン）
manifest: `projects/my8flyer/build-manifest.yml`

---

## サマリー

| 指標 | 値 |
|---|---|
| 要件総数 | 20 |
| green | 18 |
| yellow | 2 |
| red | 0 |
| stale | 0 |
| ドリフト検出 | **0件**（クリーン） |
| 抜け検出 | スキップ（overview.md なし・design単一情報源運用） |
| カバレッジ（impl_ref埋め済） | 20/20（100%） |
| カバレッジ（test_ref埋め済） | 11/20（55%） |

> 🟢 **初回ベースライン取得完了。整合性は良好。**

---

## sources ハッシュ（ベースライン）

| source | path | sha256 |
|---|---|---|
| design | `claude-vault/projects/my8flyer/architecture.md` | `7b0db692...c9e7f824` |
| test_report | `claude-vault/projects/my8flyer/test_report_2026-05-20_phase11.md` | `7d049575...9dd6173f` |

次回 `/verify` 実行時、これらのファイルが変化していたら該当要件が `stale` 判定されます。

---

## yellow 要件（要対応）

### REQ-04 — 第4条 ゾーン昇順制限
- 状態：yellow（**後半の条件未実装**）
- 理由：「乗継→目的地マイル ≤ 出発地→目的地マイル」の判定が未実装（バックログB7）
- 推奨アクション：B7着手時に実装 → status を green に更新

### REQ-20 — 単体テスト 20件全PASS
- 状態：yellow（**テストスクリプトの恒久化未実施**）
- 理由：Phase 11 で実行はしたが、Playwrightスクリプトを `projects/my8flyer/tests/` に保存していない
- 推奨アクション：`/test-design-run` で恒久化 → status を green に更新

---

## 受入再実行（verify_mode: auto の要件 10件）

| REQ | 内容 | 直近検証 | 判定 |
|---|---|---|---|
| REQ-01 | 第1条 最高マイル目的地 | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-02 | 第2条 経由不可 | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-03 | 第3条 乗換エリア制限 | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-04 | 第4条 ゾーン昇順 | 2026-05-20 (Phase 11) | ⚠️ 前半PASS / 後半未実装 |
| REQ-05 | 第5条 同一国 | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-06 | 第6条 同一エリア | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-07 | 第7条 1/2合算 | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-08 | ストップオーバー | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-09 | 乗り換え上限（2025/6/24改定） | 2026-05-20 (Phase 11) | ✅ PASS |
| REQ-17 | ツール制限明示 | 2026-05-20 (Phase 11) | ✅ PASS |

> 直近実施の Phase 11 単体テスト（20件全PASS）と完全に対応。今回はベースライン取得のためPlaywright再実行はスキップ。

---

## impl_ref 実コード突合（追加チェック）

| 参照 | 存在 |
|---|---|
| `index.html` (2626行) | ✅ |
| `workers/my8flyer-proxy/index.js` (118行) | ✅ |
| `validate()` 関数 | ✅ |
| `getLegs()` 関数 | ✅ |
| `applyOpenJawUI()` 関数 | ✅ |
| `onAwardTypeChange()` 関数 | ✅ |
| `updateTransitCounter()` 関数 | ✅ |
| `openModal()` 関数 | ✅ |
| `AWARD_RULES` 定数 | ✅ |
| `FORBIDDEN_TRANSIT_AREAS` 定数 | ✅ |
| `ZONE_TO_AREA` 定数 | ✅ |
| `ZONE_RANK` 定数 | ✅ |

manifest に記載された実装シンボルはすべて実コードに存在します。

---

## カバレッジの穴（test_ref が空の要件 9件）

| REQ | text | 影響度 |
|---|---|---|
| REQ-10 | 特典航空券タイプ切替UI | 中 |
| REQ-11 | 2モード切替（ルール/フライト確認） | 中 |
| REQ-12 | 飛行機SVGビジュアルUI | 低（手動確認しやすい） |
| REQ-13 | オープンジョー対応 | 中 |
| REQ-14 | フライト確認（Workers経由） | 高（API依存・回帰時に痛い） |
| REQ-15 | 保存ルート（KV共有） | 中 |
| REQ-16 | スマートキャッシュ | 中 |
| REQ-18 | ルール参照カード（モード別出し分け） | 低 |
| REQ-19 | 乗り換えカウンタ（モード連動） | 中 |

> **推奨**：REQ-14（Workers連携）は回帰しやすいため `/test-design-run` で先に手当てするのが良い。

---

## 次のアクション

1. **REQ-04 後半（B7）の実装** — バックログから優先度を上げて着手
2. **REQ-20 テストスクリプト恒久化** — `/test-design-run` で `projects/my8flyer/tests/` に保存
3. **REQ-14 のテスト追加** — Workers連携の回帰防止
4. **設計書変更時の運用ルール** — architecture.md を更新したら必ず `/verify --update-hashes` を実行

---

## ドリフト検知の実機確認（パイロット）

ベースライン取得後、architecture.md にコメント行を1行追加 → `diff_report.py` 再実行：

```json
{
  "drift": [{"source": "design", "old_sha256": "7b0db692...", "new_sha256": "0c994581..."}],
  "stale_requirements": [
    {"id": "REQ-01", "reasons": ["design_ref の参照先が変更されています (architecture.md#8-2)"]},
    {"id": "REQ-02", "reasons": ["design_ref の参照先が変更されています (architecture.md#8-2)"]},
    ... 19件全要件が stale 判定
  ]
}
```

**判明したバグと修正：** 初版 `diff_report.py` は絶対パスのみで比較していたため、`design_ref: architecture.md#8-2`（相対）と claude-vault配下の絶対パスがマッチしなかった。basename 一致 / 末尾パス一致を追加して修正済み。
変更後を確認し architecture.md を元に戻し → 再実行で `drift: [], stale: []` に復帰することを確認。

→ **ドリフト検知の機構は意図通りに動作することを実機確認済み。**

---

## このレポートを future-you が読むとき

`/verify` を再実行して `drift > 0` が出たら、それは前回からの「上流変更で下流が古くなっている」サインです。本レポートの sources ハッシュと現状を比較し、変わったファイルを参照する要件を中心に再確認してください。
