# つながる便の組み合わせを、実際の画面で実測する（2026-09-15）。
#   ../../.venv/bin/python tests/browser_combos.py
#
# 見たいのは「出るか」ではなく、**区間ごとの一覧を消していないか**と
# **落とすべき乗り継ぎを落とし、落としてはいけないものを残しているか**。
import subprocess, time, sys, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8798
srv = subprocess.Popen(["/usr/bin/python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
                       cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

results = []
def check(name, ok, detail=""): results.append((name, bool(ok), detail))

try:
    with sync_playwright() as p:
        b = p.chromium.launch(); pg = b.new_page()
        errors = []; alerts = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("dialog", lambda d: (alerts.append(d.message), d.dismiss()))
        pg.goto(f"http://127.0.0.1:{PORT}/index.html")
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=20000)
        pg.evaluate("async () => { await rulesReady; }")

        # 広島 → 羽田 → ロンドン → リスボン ／ 帰りは同じ道（ロンドンで途中降機）
        pg.evaluate("""async () => {
          STATE.awardType = 'partner';
          STATE.departure = 'HIJ'; STATE.destination = 'LIS'; STATE.arrival = 'HIJ';
          STATE.outbound = ['HND', 'LHR', null]; STATE.outboundSO = [false, true, false];
          STATE.return   = ['LHR', 'HND', null]; STATE.returnSO   = [false, false, false];
          updateAllDots();
          await checkFlights(true);
        }""")
        # 画面は「いちどに1つ」なので、見えているかではなく中身があるかで待つ
        pg.wait_for_selector("#flight-combos .cb-card", state="attached", timeout=90000)

        # ---------- ① 上乗せであること ----------
        check("組み合わせのカードが出る", pg.locator("#flight-combos .cb-card").count() > 0,
              f"{pg.locator('#flight-combos .cb-card').count()}件")
        check("★区間ごとの一覧を消していない", pg.locator("#flight-legs .leg-block").count() > 0,
              f"区間ブロック {pg.locator('#flight-legs .leg-block').count()}個")
        check("上乗せだと画面に書いてある", "上乗せ" in pg.inner_text("#flight-combos .cb-head"))

        # ---------- ② 行き・帰りが別々に出る ----------
        dirs = pg.eval_on_selector_all("#flight-combos .cb-dir-h", "e=>e.map(x=>x.innerText)")
        check("行きと帰りを別々に組む", any("行き" in d for d in dirs) and any("帰り" in d for d in dirs),
              str(dirs))

        # ---------- ③ 中身の検算 ----------
        data = pg.evaluate("""async () => {
          const { buildCombos } = await import('./src/combos.js');
          const legs = (dir) => { const seen = new Set();
            return getExpandedLegs().filter(l => l.dir === dir).filter(l => {
              if (seen.has(l.groupKey)) return false; seen.add(l.groupKey); return true; })
              .map(l => ({from: l.from, to: l.to, eligible: []})); };
          const out = legs('out');
          return { outKeys: out.map(l => l.from + '-' + l.to),
                   store: { out: COMBO_STORE.out.length, ret: COMBO_STORE.ret.length },
                   plans: COMBO_STORE.out.map(p => ({
                     legs: p.legs.map(l => ({no: l.no, depDay: l.depDay})),
                     conns: p.conns.map(c => ({via: c.via, m: c.minutes, need: c.need,
                                               src: c.source, ok: c.ok, so: c.isStopover})),
                     total: p.totalMin })) };
        }""")
        check("行きの区間が旅程どおり", data["outKeys"] == ["HIJ-HND", "HND-LHR", "LHR-LIS"], str(data["outKeys"]))
        check("★行き・帰りとも案を持っている（方向の呼び名がアプリと揃っているか）", data["store"]["out"] > 0 and data["store"]["ret"] > 0, str(data["store"]))

        for pl in data["plans"]:
            hnd = next(c for c in pl["conns"] if c["via"] == "HND")
            check(f"羽田の乗り継ぎがANA公式を満たす（{hnd['m']}分／必要{hnd['need']}分）",
                  hnd["m"] >= hnd["need"] and hnd["src"] == "official")
            lhr = next(c for c in pl["conns"] if c["via"] == "LHR")
            check(f"ロンドンで24時間以上とまっている（{lhr['m']}分）", lhr["so"] is True)
            check("ロンドンはANA公式でなく8flyerの既定値で見ている", lhr["src"] == "default")

        # ---------- ④ 途中降機を外すと、結果が入れ替わる ----------
        before = [tuple((l["no"], l["depDay"]) for l in p["legs"]) for p in data["plans"]]
        pg.evaluate("""async () => {
          STATE.outboundSO = [false, false, false];
          updateAllDots();
          await checkFlights(true);
        }""")
        pg.wait_for_timeout(1500)
        after = pg.evaluate("COMBO_STORE.out.map(p => p.legs.map(l => [l.no, l.depDay]))")
        after_t = [tuple(tuple(x) for x in p) for p in after]
        check("★途中降機を外すと出てくる案が変わる", set(before).isdisjoint(set(after_t)),
              f"泊まる={before[:1]} 泊まらない={after_t[:1]}")
        check("泊まらない指定では24時間以上の乗り継ぎが無い",
              pg.evaluate("COMBO_STORE.out.every(p => p.conns.every(c => c.minutes < 1440))"))

        # ---------- ⑤ 区間ごとの日付がANAへ渡る ----------
        pg.evaluate("""() => { window.__sent = [];
          window.addEventListener('message', e => {
            if (e.source === window && e.data && e.data.type === 'my8flyer:route') window.__sent.push(e.data); }); }""")
        alerts.clear()
        pg.evaluate("comboUse('out', 0)")
        check("基準日が無ければ、そう言って止まる", any("往路日" in a for a in alerts), str(alerts))

        # 同じ理由で見えないので、値は直接入れる
        pg.evaluate("document.getElementById('ana-date-out').value = '2027-01-18'; document.getElementById('ana-date-in').value = '2027-01-28';")
        alerts.clear()
        # ★日ずれが効いているかを見たいので、日をまたぐ案があればそれを選ぶ
        idx = pg.evaluate("(() => { const i = COMBO_STORE.out.findIndex("
                          "p => p.legs.some(l => l.depDay > 0)); return i < 0 ? 0 : i; })()")
        pg.evaluate(f"comboUse('out', {idx})")
        check("日付を決めたことを伝える", any("日付を決めました" in a for a in alerts), str(alerts)[:80])

        pg.evaluate("sendRouteToAnaBridge()"); pg.wait_for_timeout(300)
        sent = pg.evaluate("window.__sent[0] || null")
        dates = [l.get("date") for l in sent["legs"]] if sent else []
        plan0 = pg.evaluate(f"COMBO_STORE.out[{idx}].legs.map(l => l.depDay)")
        want = []
        import datetime
        base = datetime.date(2027, 1, 18)
        for dd in plan0:
            want.append((base + datetime.timedelta(days=dd)).isoformat())
        check("★行きの区間ごとに、日ずれを足した日付が渡る", dates[:len(want)] == want,
              f"渡った={dates[:len(want)]} 期待={want}")
        if max(plan0) > 0:
            check("★日をまたぐ区間は、翌日の日付になっている",
                  len(set(dates[:len(want)])) > 1, f"{dates[:len(want)]} / 日ずれ={plan0}")
        check("帰りは基準日のまま（組み合わせ未選択）",
              all(d == "2027-01-28" for d in dates[len(want):]), str(dates[len(want):]))

        # ---------- ⑥ ルートを変えたら持ち越さない ----------
        pg.evaluate("STATE.outbound = ['HND','FRA',null]; updateAllDots();")
        check("★ルートを変えたら、前に選んだ組み合わせを捨てる",
              pg.evaluate("COMBO_PICK.out === null && COMBO_PICK.ret === null"))

        check("JSエラーが出ていない", not errors, str(errors[:2]))
        b.close()
finally:
    srv.terminate()

ng = [r for r in results if not r[1]]
for n, ok, d in results: print(("  OK  " if ok else "  NG  ") + n + (f"   {d}" if d else ""))
print(f"\n{len(results)-len(ng)}/{len(results)} PASS")
sys.exit(1 if ng else 0)
