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

        # ===== 実便を持っていない区間の言い方（2026-09-22・REQ-100／101）=====
        # ★「まだ取得していません」だけだと「押せば取れる」と読め、実際には押しても増えない。
        #   何が確認済みで何が未確認かと、利用者にできることを書く。
        #   検査は実便データから区間をわざと外して「持っていない状態」を作る（実データの増減に左右されない）
        t = pg.evaluate("""async () => {
            const keys = ['HND-CDG', 'CDG-HND'];
            const saved = {};
            keys.forEach((k) => { saved[k] = FLIGHTS_DB.legs[k]; delete FLIGHTS_DB.legs[k]; });
            Object.assign(STATE, {
              awardType:'partner', departure:'HND', destination:'CDG', arrival:null, returnDep:null,
              outbound:[null,null,null], return:[null,null,null], outboundSO:[false,false,false],
              returnSO:[false,false,false], outboundSurface:[false,false,false], returnSurface:[false,false,false],
            });
            await checkFlights(true);
            const out = { legs: document.getElementById('flight-legs').innerText,
                          note: document.getElementById('flight-connections').innerText };
            keys.forEach((k) => { FLIGHTS_DB.legs[k] = saved[k]; });
            return out;
        }""")
        results.append(("持っていない区間は「路線としては飛ぶ」ことを併記する",
                        "路線としては飛びます" in t["legs"] and "まだ取得していません" not in t["legs"],
                        t["legs"][:110].replace("\n", " ")))
        results.append(("まとめに、確認済みのことと未確認のことを両方書く",
                        "路線辞書で確認" in t["note"] and "裏取り" in t["note"],
                        t["note"][:110].replace("\n", " ")))
        results.append(("まとめに、利用者にできることを書く",
                        "Googleフライトで便名を見る" in t["note"], t["note"][-70:].replace("\n", " ")))

        # ===== 見た範囲は区間ごとに違う（2026-09-22・REQ-103）=====
        # ★全体の window で「◯◯の週」と書くと、1日しか見ていない区間まで週ぶん見たことになる。
        #   実測：ハノイ⇄アムステルダムは火・土の週2便で、月曜だけ見ると0本だった
        t2 = pg.evaluate("""async () => {
            const k = 'HND-CDG';
            const saved = FLIGHTS_DB.legs[k];
            const read = async (rec) => {
                FLIGHTS_DB.legs[k] = rec;
                Object.assign(STATE, {
                  awardType:'partner', departure:'HND', destination:'CDG', arrival:null, returnDep:null,
                  outbound:[null,null,null], return:[null,null,null], outboundSO:[false,false,false],
                  returnSO:[false,false,false], outboundSurface:[false,false,false], returnSurface:[false,false,false],
                });
                await checkFlights(true);
                return document.getElementById('flight-legs').innerText;
            };
            const out = {
              // 1日しか見ていない区間で0本
              partial: await read({ status:'no_nonstop', seen:'1??????', flights:[] }),
              // 7日ぶん見て0本
              full:    await read({ status:'no_nonstop', seen:'1111111', flights:[] }),
            };
            FLIGHTS_DB.legs[k] = saved;
            return out;
        }""")
        results.append(("1日しか見ていない区間で「の週」と書かない",
                        "の週" not in t2["partial"] and "1日ぶん" in t2["partial"],
                        t2["partial"][:110].replace("\n", " ")))
        results.append(("0本でも、見ていない曜日があるならそう書く",
                        "見ていない曜日があります" in t2["partial"],
                        t2["partial"][:140].replace("\n", " ")))
        results.append(("7日ぶん見て0本なら、直行便が無いと言い切る",
                        "直行便はありません" in t2["full"] and "見ていない曜日" not in t2["full"],
                        t2["full"][:140].replace("\n", " ")))

        # 実データで確かめる：ハノイ⇄アムステルダムは週2便（火・土）で、飛ぶ日が出る
        han = pg.evaluate("""() => {
            const r = FLIGHTS_DB.legs['HAN-AMS'];
            return r ? { status: r.status, seen: r.seen, days: (r.flights[0]||{}).days,
                         no: (r.flights[0]||{}).no } : null;
        }""")
        results.append(("★ハノイ→アムステルダムに実便がある（1日だけ見て0本と書いていた区間）",
                        bool(han) and han["status"] == "ok" and han["days"].count("1") >= 1,
                        str(han)))

        # ボタンは押しても実便が増えない。「再取得」という名前を付けない        # ボタンは押しても実便が増えない。「再取得」という名前を付けない
        label = pg.evaluate("document.querySelector('.btn-refresh').textContent.trim()")
        results.append(("押しても外から取ってこないボタンを「再取得」と名乗らない",
                        "再取得" not in label and label != "", label))

        results.append(("JSエラーなし", not errors, str(errors[:3])))
        b.close()
finally:
    srv.terminate()

ok = sum(1 for _, r, _ in results if r)
for name, r, detail in results:
    print(f"{'✅' if r else '❌'} {name}" + (f"  — {detail}" if detail and not r else ""))
print(f"\n{ok}/{len(results)} PASS")
sys.exit(0 if ok == len(results) else 1)
