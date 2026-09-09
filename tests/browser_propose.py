# S1〜S3（もう1都市の提案）を実ブラウザで通す。
# 画面から proposer/miles-core が呼べているか、選んだ旅程が
# 「じぶんで組む」（従来の判定UI）へ渡るかを実測する。
import subprocess, time, os, sys
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8791  # 8787/8788 は司令室（infra-inventory）

srv = subprocess.Popen(
    ["/usr/bin/python3", "-m", "http.server", str(PORT), "--bind", "127.0.0.1"],
    cwd=ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)

results = []
def check(name, ok, detail=""):
    results.append((name, ok, detail))

try:
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 430, "height": 900})
        errors = []
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: errors.append(f"console.error: {m.text}") if m.type == "error" else None)
        pg.goto(f"http://127.0.0.1:{PORT}/index.html")
        # ★ window.RULES_CFG では待てない（トップレベルの let は window に生えないため常に undefined ≠ null）。
        # 読み込みの完了そのものを待つ
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.evaluate("async () => { await rulesReady; }")

        pg.select_option("#pp-origin", "HND")
        pg.select_option("#pp-dest", "CDG")
        pg.select_option("#pp-award", "partner")
        t0 = time.time()
        pg.click("#pp-go")
        pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        elapsed = time.time() - t0

        rows = pg.eval_on_selector_all("#pp-list .pp-city", "els => els.length")
        check("候補が出る", rows >= 10, f"{rows}行 / {elapsed:.1f}秒")
        check("提案が10秒以内に出る", elapsed < 10, f"{elapsed:.1f}秒")

        foot = pg.inner_text("#pp-foot")
        check("集計文が出る", "都市に畳み" in foot, foot[:90])

        # 🏠（自宅で途中降機）を持つ都市を探して開く
        found = pg.evaluate("""() => {
            const i = PP.rows.findIndex(r => r.ways.some(w => w.extraVia === 'home'));
            if (i < 0) return null;
            PP.sel = i; PP.way = 0; ppRender();
            const r = PP.rows[i];
            return { city: r.city, ways: r.ways.map(w => w.extraVia + (w.homeLeg ? ':' + w.homeLeg : '')) };
        }""")
        check("🏠 を持つ都市がある", found is not None, str(found))

        if found:
            pg.wait_for_selector(".pp-way.home", timeout=5000)
            pg.click(".pp-way.home")
            pg.wait_for_selector("#pp-s3:not([hidden])", timeout=5000)
            title = pg.inner_text("#pp-s3-title")
            note  = pg.inner_text("#pp-s3-note")
            legs  = pg.eval_on_selector_all("#pp-legs .pp-leg", "els => els.length")
            so    = pg.eval_on_selector_all("#pp-legs .pp-leg.so", "els => els.length")
            kinds = pg.inner_text("#pp-kinds")
            check("旅程画面が開く", "＋" in title, title)
            check("自宅での途中降機だと分かる", "自宅" in note or "国内線" in note, note[:70])
            check("区間が並ぶ", legs >= 3, f"{legs}区間")
            check("途中降機の区間に印が付く", so == 1, f"印 {so}件")
            check("成立する特典が出る", "提携特典" in kinds, kinds.replace("\n", " ")[:90])

            # 「じぶんで組む」へ渡す
            pg.click("button[onclick='ppToEditor()']")
            time.sleep(1.2)
            st = pg.evaluate("({dep: STATE.departure, arr: STATE.arrival, so: STATE.returnSO.concat(STATE.outboundSO)})")
            summary = pg.inner_text("#result-summary")
            check("編集画面に旅程が入る", st["dep"] is not None, str(st))
            check("従来の判定も通る", "OK" in summary or "問題" in summary or "適合" in summary,
                  summary.replace("\n", " ")[:90])

        # 帰りの場所を自分で指定して検索する（往路と復路で場所を変える）
        pg.select_option("#pp-origin", "FUK")
        pg.select_option("#pp-dest", "LIS")
        pg.select_option("#pp-arrival", "HND")     # 福岡発 → リスボン → 羽田着（帰りに降りる場所を指定）
        pg.click("#pp-go")
        pg.wait_for_function("PP.req && PP.req.arrival === 'HND'", timeout=60000)
        pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        rows2 = pg.eval_on_selector_all("#pp-list .pp-city", "els => els.length")
        pin   = pg.inner_text("#pp-cond-pin")
        base  = pg.inner_text("#pp-base")
        bad   = pg.evaluate("PP.rows.filter(r => r.iata === 'HND').length")
        check("帰りの場所を指定して検索できる", rows2 >= 5, f"{rows2}都市")
        check("指定した場所が条件バーに出る", "羽田" in pin, pin)
        check("指定した旅程が基準になる", "リスボン" in base and "羽田" in base, base.replace("\n", " ")[:90])
        check("指定した街を「もう1都市」に数えない", bad == 0, f"混入 {bad}件")

        # ANA便でしか飛べない旅程の扱い（2026-09-08）：
        # 途中降機つきは提案に出さない／途中降機なしは「ANA特典扱い」と印を付ける
        pg.select_option("#pp-origin", "HND")
        pg.select_option("#pp-dest", "HNL")
        pg.select_option("#pp-arrival", "")
        pg.click("#pp-go")
        pg.wait_for_function("PP.req && PP.req.destination === 'HNL' && PP.rows.length > 3", timeout=60000)
        bad = pg.evaluate("""() => {
            const sole = (legs) => legs.length && legs.every(l => l.airlines.length === 1 && l.airlines[0] === 'NH');
            return PP.rows.flatMap(r => r.ways).filter(w => w.stopover && sole(w.carriersByLeg)).length;
        }""")
        check("ANA便だけの途中降機つきは提案に出ない", bad == 0, f"{bad}本")

        info = pg.evaluate("""() => {
            const i = PP.rows.findIndex(r => r.ways.some(w => w.actualAward === 'ana'));
            if (i < 0) return null;
            PP.sel = i; PP.way = PP.rows[i].ways.findIndex(w => w.actualAward === 'ana'); ppRender();
            const w = PP.rows[i].ways[PP.way];
            return { city: PP.rows[i].city, miles: w.miles, note: w.milesNote };
        }""")
        check("ANA便だけで組める案が「ANA特典扱い」になる", info is not None, str(info))
        if info:
            check("マイルがANAのチャート（シーズンつき）になる", 'シーズン' in (info.get('note') or ''), str(info.get('note')))
            badge = pg.eval_on_selector_all(".pp-warn", "els => els.length")
            check("一覧に「ANA特典扱い」の印が出る", badge >= 1, f"{badge}件")
            pg.click(".pp-way.on")
            pg.wait_for_selector("#pp-s3:not([hidden])", timeout=5000)
            note = pg.inner_text("#pp-s3-note")
            check("旅程画面にANA特典扱いの理由が出る", "ANA国際線特典として扱われます" in note, note[:80])

        check("JSエラーが出ない", len(errors) == 0, " / ".join(errors[:3]))
        b.close()
finally:
    srv.terminate()

ng = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("✅" if ok else "❌") + f" {name}" + (f" — {detail}" if detail else ""))
print(f"\n{len(results) - len(ng)}/{len(results)} PASS")
sys.exit(1 if ng else 0)
