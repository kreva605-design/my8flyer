# 「空いている日を実際の日付で見せる／ANAへ日付を渡す」をブラウザで実測する（2026-09-13）。
#   ../../.venv/bin/python tests/browser_dates.py
#
# 見たいのは「出るか」ではなく、**出している日付が集計値と同じ根拠から来ているか**と、
# **拡張へ本当に日付が乗って出ていくか**。画面に数字が出るだけなら嘘でも出せる。
import subprocess, time, sys, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8793

srv = subprocess.Popen(["/usr/bin/python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                       cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

results = []
def check(name, ok, detail=""):
    results.append((name, bool(ok), detail))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("dialog", lambda d: (ALERTS.append(d.message), d.dismiss()))
        ALERTS = []
        pg.goto(f"http://127.0.0.1:{PORT}/index.html")
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.evaluate("async () => { await rulesReady; }")
        pg.evaluate("async () => { await ensureAwardCal(); }")

        # ---------- ① 検索ボタンの名前と位置 ----------
        pg.evaluate("ppGo('s1')")
        pg.select_option("#pp-origin", "HIJ"); pg.select_option("#pp-dest", "CDG")
        pg.select_option("#pp-arrival", "")
        pg.click("#pp-go"); pg.wait_for_selector("#pp-list .pp-city", timeout=60000)

        label = pg.inner_text(".pp-cal-go")
        check("ボタン名が『国内↔海外の空いているANA便の往路復路の日程を検索』",
              "国内↔海外の空いているANA便の往路復路の日程を検索" in label, label)

        # 一覧より前（画面の上）にあること。DOMの前後で判定する
        before = pg.evaluate("""() => {
          const bar = document.getElementById('pp-cal-bar');
          const list = document.getElementById('pp-list');
          if (!bar || !list) return null;
          return (bar.compareDocumentPosition(list) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
        }""")
        check("ボタンが候補一覧より上にある", before is True, str(before))
        check("ボタンが見えている（拡張なしでも位置は変わらない）",
              pg.evaluate("!document.getElementById('pp-cal-bar').hidden") in (True, False))

        # ---------- ② 旅程の詳細に、行き／帰りの日付が別々に出る ----------
        # 都市の行を開く → 行き方を1つ選ぶと旅程の詳細になる
        pg.eval_on_selector_all("#pp-list .pp-city", "e => e[1].click()")
        pg.wait_for_selector("#pp-list .pp-way", timeout=15000)
        pg.eval_on_selector_all("#pp-list .pp-way", "e => e[0].click()")
        pg.wait_for_selector("#pp-dates .pp-date", timeout=15000)
        dtxt = pg.inner_text("#pp-dates")
        check("詳細画面に『行き』の空き日が出る", "行き" in dtxt, dtxt[:60])
        check("詳細画面に『帰り』の空き日が出る", "帰り" in dtxt)
        check("目安であることを添えている", "目安" in dtxt)
        check("往復そろう日を断定していない", "空席照会で確かめて" in dtxt)

        # ★画面の日数が、カレンダーの生データを数え直した値と一致する
        cmp = pg.evaluate("""() => {
          const sd = ppSeatDateLists(PP.chosen);
          const recount = (rec) => rec ? [...(AWARD_CAL.legs[rec.key].avail)]
                                          .filter(c => c==='2'||c==='3').length : null;
          return { outShown: sd.out ? sd.out.ok.length : null, outRaw: recount(sd.out),
                   inShown: sd.back ? sd.back.ok.length : null, inRaw: recount(sd.back),
                   outKey: sd.out && sd.out.key, inKey: sd.back && sd.back.key };
        }""")
        check("行きの日数が生データの数え直しと一致",
              cmp["outShown"] == cmp["outRaw"], f"{cmp['outKey']} 画面={cmp['outShown']} 生={cmp['outRaw']}")
        check("帰りの日数が生データの数え直しと一致",
              cmp["inShown"] == cmp["inRaw"], f"{cmp['inKey']} 画面={cmp['inShown']} 生={cmp['inRaw']}")

        # ★1件目の日付が、カレンダーの起点から数えた日付と一致する（ずれていないか）
        first = pg.evaluate("""() => {
          const sd = ppSeatDateLists(PP.chosen);
          const rec = AWARD_CAL.legs[sd.out.key];
          const i = [...rec.avail].findIndex(c => c==='2'||c==='3');
          const d = new Date(AWARD_CAL._meta.from + 'T00:00:00');
          d.setDate(d.getDate() + i);
          return { shown: ppFmtMD(sd.out.ok[0]), want: ppFmtMD(d), idx: i };
        }""")
        check("最初の日付がカレンダーの起点から数えた日と一致",
              first["shown"] == first["want"], f"画面={first['shown']} 期待={first['want']} (i={first['idx']})")

        # ★行きと帰りを足していない・掛けていない
        check("行きと帰りを合算した数を出していない",
              str(cmp["outShown"] + cmp["inShown"]) not in dtxt,
              f"合算={cmp['outShown'] + cmp['inShown']}")

        # ---------- ③ 「ANAに入れる日付」欄と候補ボタン ----------
        pg.evaluate("ppToEditor()")
        pg.wait_for_timeout(600)
        check("『ANAに入れる日付』の欄がある", pg.is_visible("#ana-dates"))
        check("往路日の欄がある", pg.is_visible("#ana-date-out"))
        check("復路日の欄がある", pg.is_visible("#ana-date-in"))
        picks = pg.eval_on_selector_all("#ana-date-pick .ana-pick-row button", "e=>e.map(x=>x.innerText)")
        check("空いている日の候補ボタンが出る", len(picks) > 0, f"{len(picks)}個 例={picks[:3]}")

        if picks:
            pg.eval_on_selector_all("#ana-date-pick .ana-pick-row button", "e => e[0].click()")
            v = pg.input_value("#ana-date-out")
            check("候補ボタンを押すと往路日の欄に入る", bool(re.fullmatch(r"\d{4}-\d{2}-\d{2}", v or "")), v)

        # ---------- ④ 拡張へ日付が乗って出ていく ----------
        pg.evaluate("""() => {
          window.__sent = [];
          window.addEventListener('message', (e) => {
            if (e.source === window && e.data && e.data.type === 'my8flyer:route') window.__sent.push(e.data);
          });
        }""")
        pg.fill("#ana-date-out", "2026-11-21")
        pg.fill("#ana-date-in", "2026-11-29")
        pg.evaluate("sendRouteToAnaBridge()")
        pg.wait_for_timeout(300)
        sent = pg.evaluate("window.__sent[0] || null")
        check("拡張へ旅程が出ていく", bool(sent and sent.get("legs")), str(sent)[:60])
        if sent:
            legs = sent["legs"]
            dates = [l.get("date") for l in legs]
            check("すべての区間に日付が付いている", all(dates), str(dates))
            check("往路の区間に往路日が入る", dates[0] == "2026-11-21", str(dates))
            check("復路の区間に復路日が入る", dates[-1] == "2026-11-29", str(dates))
            check("往路日と復路日が混ざっていない",
                  set(dates) == {"2026-11-21", "2026-11-29"}, str(sorted(set(dates))))

        # ---------- ⑤ 逆転した日付は送らない ----------
        ALERTS.clear()
        pg.evaluate("window.__sent = []")
        pg.fill("#ana-date-out", "2026-11-29")
        pg.fill("#ana-date-in", "2026-11-21")
        pg.evaluate("sendRouteToAnaBridge()")
        pg.wait_for_timeout(300)
        check("復路が往路より前なら送らない", pg.evaluate("window.__sent.length") == 0,
              f"送信={pg.evaluate('window.__sent.length')}件")
        check("その理由を画面で伝える", any("復路日が往路日より前" in a for a in ALERTS), str(ALERTS))

        # ---------- ⑥ 日付なしでも開ける ----------
        ALERTS.clear()
        pg.evaluate("window.__sent = []")
        pg.fill("#ana-date-out", ""); pg.fill("#ana-date-in", "")
        pg.evaluate("sendRouteToAnaBridge()")
        pg.wait_for_timeout(300)
        s2 = pg.evaluate("window.__sent[0] || null")
        check("日付が空でも旅程は送れる", bool(s2 and s2.get("legs")))
        check("空のときは日付を付けない（拡張の前回値を潰さない）",
              bool(s2) and all("date" not in l for l in s2["legs"]), str(s2)[:80] if s2 else "")

        check("JSエラーが出ていない", not errors, str(errors[:2]))
        b.close()
finally:
    srv.terminate()

ng = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("  OK  " if ok else "  NG  ") + name + (f"   {detail}" if detail else ""))
print(f"\n{len(results) - len(ng)}/{len(results)} PASS")
sys.exit(1 if ng else 0)
