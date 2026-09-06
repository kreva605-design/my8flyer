// background.js — 調査用スパイク（S-0）のサービスワーカー
//
// 役割は1つだけ:
//   content.js から「集めて」と言われたら、そのタブの全フレームから
//   URL と HTML を読み取って返す。
//
// ★ 書き込み・遷移・外部送信は一切行わない。読むだけ。
// フレームを分けて集めるのは、ANA の予約画面が iframe を使っている可能性があり、
// トップフレームの HTML だけではカレンダー本体を取り逃がすため。

/**
 * 各フレームの中で実行される関数（chrome.scripting.executeScript で注入）。
 * ここは注入先のページ文脈で動くので、外側の変数を参照してはいけない。
 */
function grabFrame() {
  return {
    url: location.href,
    title: document.title,
    // レンダリング後の DOM をそのまま取る（JSF が組み立てた後の状態が欲しい）
    html: document.documentElement.outerHTML,
    // 参考情報: 画面に見えているテキストの長さ（空フレームの判別用）
    textLength: (document.body && document.body.innerText || "").length,
  };
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type !== "m8f-collect") return;

  const tabId = sender.tab?.id;
  if (tabId == null) {
    sendResponse({ ok: false, error: "タブIDが取得できませんでした" });
    return;
  }

  chrome.scripting
    .executeScript({
      target: { tabId, allFrames: true },
      func: grabFrame,
    })
    .then((results) => {
      // results: [{ frameId, result: {url,title,html,textLength} }, ...]
      const frames = results
        .filter((r) => r && r.result)
        .map((r) => ({ frameId: r.frameId, ...r.result }));
      sendResponse({ ok: true, frames });
    })
    .catch((e) => {
      sendResponse({ ok: false, error: String(e && e.message ? e.message : e) });
    });

  // 非同期で sendResponse を呼ぶので true を返す必要がある
  return true;
});
