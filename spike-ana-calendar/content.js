// content.js — 調査用スパイク（S-0）の画面側
//
// やること: 画面右下にボタンを出し、押されたら「今表示されている画面」の
//           HTML を全フレームぶん集めて、1つの JSON ファイルとして保存する。
//
// ★ やらないこと（意図的に実装していない）:
//   - フォームへの書き込み
//   - 「検索する」等のクリック
//   - ページ遷移・リロード
//   - 外部サーバーへの送信（保存先はあなたのダウンロードフォルダだけ）

(() => {
  const BTN_ID = "m8f-spike-fab";
  const MSG_ID = "m8f-spike-msg";

  if (document.getElementById(BTN_ID)) return; // 二重注入の保険

  // ===== UI =====
  const fab = document.createElement("button");
  fab.id = BTN_ID;
  fab.type = "button"; // ← 既定の submit を避ける（フォーム送信させない）
  fab.textContent = "📋 この画面を保存";
  document.documentElement.appendChild(fab);

  const msg = document.createElement("div");
  msg.id = MSG_ID;
  msg.hidden = true;
  document.documentElement.appendChild(msg);

  function say(text, tone) {
    msg.textContent = text;
    msg.dataset.tone = tone || "info";
    msg.hidden = false;
  }

  // ===== 保存 =====
  function download(bundle) {
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\..+$/, "")
      .replace("T", "-");
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `m8f-ana-calendar_${stamp}.json`;
    document.documentElement.appendChild(a);
    a.click();
    a.remove();
    // 少し待ってから解放（Safari以外は即時でも良いが念のため）
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // 空席記号らしきものが何個あるかをざっと数える（成否の手応え用。判定には使わない）
  function countSymbols(html) {
    const marks = ["○", "◯", "△", "×", "✕", "－", "-"];
    const counts = {};
    for (const m of marks) {
      const n = html.split(m).length - 1;
      if (n > 0) counts[m] = n;
    }
    return counts;
  }

  fab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    fab.disabled = true;
    say("収集中…", "info");

    chrome.runtime.sendMessage({ type: "m8f-collect" }, (res) => {
      fab.disabled = false;

      if (chrome.runtime.lastError) {
        say("拡張との通信に失敗: " + chrome.runtime.lastError.message, "error");
        return;
      }
      if (!res || !res.ok) {
        say("取得に失敗: " + (res && res.error ? res.error : "原因不明"), "error");
        return;
      }

      const bundle = {
        _meta: {
          capturedAt: new Date().toISOString(),
          topUrl: location.href,
          topTitle: document.title,
          frameCount: res.frames.length,
          note:
            "My 8flyer S-0 スパイク。ANA特典カレンダーの構造確認用。読み取りのみ。",
        },
        frames: res.frames.map((f) => ({
          ...f,
          symbolCounts: countSymbols(f.html || ""),
        })),
      };

      download(bundle);

      const total = res.frames.reduce((s, f) => s + (f.html || "").length, 0);
      const withSymbols = bundle.frames.filter(
        (f) => Object.keys(f.symbolCounts).length > 0
      ).length;
      say(
        `保存しました（フレーム ${res.frames.length}件 / 合計 ${(
          total / 1024
        ).toFixed(0)}KB / 記号を含むフレーム ${withSymbols}件）`,
        "ok"
      );
    });
  });
})();
