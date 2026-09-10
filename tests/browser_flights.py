# 実便（S-4）が画面に出るかをブラウザで実測する。
#   ../../.venv/bin/python tests/browser_flights.py
# 見たいのは「便が出るか」ではなく **「出してはいけない便が出ていないか」**。
# 路線辞書は HIJ-HND を NH だけと言うが、実便には JAL が7本混ざっている。
import subprocess, time, sys, os
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8791  # 8787/8788 は司令室が使用中（infra-inventory）

srv = subprocess.Popen(
    ["/usr/bin/python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

results = []
try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page()
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{PORT}/index.html")
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.evaluate("async () => { await rulesReady; }")

        # 実便データそのものが読めているか
        loaded = pg.evaluate("async () => { await ensureFlightsDB(); return !!FLIGHTS_DB; }")
        results.append(("実便データ(data/flights.json)を読める", loaded is True, str(loaded)))
        meta = pg.evaluate("FLIGHTS_DB && {win: FLIGHTS_DB.window, n: Object.keys(FLIGHTS_DB.legs||{}).length}")
        results.append(("区間が入っている", bool(meta and meta["n"] > 100), str(meta)))

        def card(state):
            return pg.evaluate("""async (st) => {
                Object.assign(STATE, {
                  awardType:'partner', departure:null, destination:null, arrival:null, returnDep:null,
                  outbound:[null,null,null], return:[null,null,null],
                  outboundSO:[false,false,false], returnSO:[false,false,false],
                  outboundSurface:[false,false,false], returnSurface:[false,false,false],
                }, st);
                await checkFlights(true);
                return document.getElementById('flight-legs').innerText;
            }""", state)

        txt = card({"departure": "HIJ", "destination": "CDG", "outbound": ["HND", None, None]})

        results.append(("実便の見出しが出る", "実便（" in txt, txt[:90].replace("\n", " / ")))
        results.append(("特典の空席ではないと断っている", "特典の空席ではありません" in txt, ""))

        # ★運航会社での絞り込み。HIJ-HND の実便には JAL が7本あるが出してはいけない
        import re
        block = txt.split("→ 東京")[0] if "→ 東京" in txt else txt
        jl = re.findall(r"\bJL\d+\b", txt)
        results.append(("ANAマイルで乗れないJAL便を出していない", not jl, f"JL便={jl[:5]}"))
        nh = re.findall(r"\bNH\d+\b", txt)
        results.append(("ANA便は出ている", len(nh) >= 2, f"NH便={nh[:6]}"))

        # 曜日ラベル
        results.append(("飛ぶ曜日が出る", ("毎日" in txt or any(d in txt for d in "月火水木金土日")), ""))

        # ★payload2か所読み取りの是正が画面まで届いているか（NH211＝羽田-ロンドン）
        txt2 = card({"departure": "HND", "destination": "LHR"})
        results.append(("羽田→ロンドンにANAの便が出る（取りこぼし是正の確認）",
                        "NH211" in txt2, re.findall(r"\b[A-Z0-9]{2}\d+\b", txt2)[:6]))

        # ===== REQ-61：実便の運航会社で特典判定をやり直す =====
        def conn(state):
            pg.evaluate("""async (st) => {
                Object.assign(STATE, {
                  awardType:'partner', departure:null, destination:null, arrival:null, returnDep:null,
                  outbound:[null,null,null], return:[null,null,null], outboundSO:[false,false,false],
                  returnSO:[false,false,false], outboundSurface:[false,false,false], returnSurface:[false,false,false],
                }, st);
                await checkFlights(true);
            }""", state)
            return pg.evaluate("document.getElementById('flight-connections').innerText")

        t = conn({"departure": "HIJ", "destination": "CDG", "outbound": ["HND", None, None]})
        results.append(("全区間ANA運航ならANA国際線特典だと指摘する",
                        "ANA国際線特典" in t, t[:80].replace("\n", " ")))
        t = conn({"departure": "HND", "destination": "CDG", "outbound": ["FRA", None, None]})
        results.append(("LH運航の区間を含むなら指摘しない",
                        "ANA国際線特典" not in t, t[:80].replace("\n", " ")))

        results.append(("JSエラーなし", not errors, str(errors[:3])))
        b.close()
finally:
    srv.terminate()

ok = sum(1 for _, r, _ in results if r)
for name, r, detail in results:
    print(f"{'✅' if r else '❌'} {name}" + (f"  — {detail}" if detail and not r else ""))
print(f"\n{ok}/{len(results)} PASS")
sys.exit(0 if ok == len(results) else 1)
