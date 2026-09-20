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
        pg.select_option("#pp-award", "star")   # 2026-09-19 以降 partner は「提携1社」の意味
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
            PP.selKey = PP.rows[i].iata + '|' + (PP.rows[i].plan ?? '-'); PP.way = 0; ppRender();
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

        # 帰りの場所を自分で指定して検索する（画面が切り替わるので、さがすへ戻ってから）
        pg.evaluate("ppGo('s1')")
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
        pg.evaluate("ppGo('s1')")
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
            PP.selKey = PP.rows[i].iata + '|' + (PP.rows[i].plan ?? '-'); PP.way = PP.rows[i].ways.findIndex(w => w.actualAward === 'ana'); ppRender();
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

        # 画面がいちどに1つだけ出ること（2026-09-09）
        # ★2026-09-20 に画面へ URL を持たせたので、ハッシュ付きで再読込すると
        #   その画面へ復帰する。ここは「まっさらに開いたとき」の検査なので、
        #   ハッシュを外した URL で開き直す（復帰そのものは後段で別に検査する）
        pg.goto(f"http://127.0.0.1:{PORT}/index.html")
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        vis = lambda i: pg.is_visible(f"#{i}")
        check("ハッシュ無しで開いたら「さがす」だけ", vis("pp-s1") and not vis("pp-s2") and not vis("pp-s3")
              and not vis("pane-editor"), None)
        pg.select_option("#pp-origin", "HND"); pg.select_option("#pp-dest", "CDG")
        pg.click("#pp-go"); pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        check("検索すると「候補」に切り替わる", vis("pp-s2") and not vis("pp-s1"), None)
        pg.evaluate("() => { PP.selKey = PP.rows[0].iata + '|' + (PP.rows[0].plan ?? '-'); PP.way = 0; ppRender(); }")
        pg.click(".pp-way")
        pg.wait_for_selector("#pp-s3:not([hidden])", timeout=5000)
        check("行き方を選ぶと「旅程」に切り替わる", vis("pp-s3") and not vis("pp-s2"), None)
        pg.click("button[onclick='ppToEditor()']")
        time.sleep(0.8)
        check("読み込むと「じぶんで組む」に切り替わる", vis("pane-editor") and not vis("pp-s3"), None)
        pg.click("button[onclick='ppBackFromEditor()']")
        time.sleep(0.4)
        check("提案に戻れる", vis("pp-s3") and not vis("pane-editor"), None)

        # 往路側の裏技は往路の経路を見せる（復路だけ出すと意味が伝わらない）
        pg.click("button[onclick='ppBackToList()']")
        time.sleep(0.4)
        out = pg.evaluate("""() => {
            const i = PP.rows.findIndex(r => r.ways.some(w => w.homeLeg === 'out'));
            if (i < 0) return null;
            PP.selKey = PP.rows[i].iata + '|' + (PP.rows[i].plan ?? '-'); PP.way = PP.rows[i].ways.findIndex(w => w.homeLeg === 'out'); ppRender();
            const el = document.querySelector('.pp-way.on .wd');
            return { text: el ? el.textContent : null, route0: PP.rows[i].ways[PP.way].route[0] };
        }""")
        check("「国内線を先に飛ぶ」は往路の経路を出す",
              out is not None and out["text"].startswith("往路") and out["route0"] in out["text"],
              str(out))

        # 2026-09-10 追加の4件
        pg.evaluate("ppGo('s1')")
        grp = pg.evaluate("""() => ({
            dest: [...document.querySelectorAll('#pp-dest optgroup')].map(g => g.label),
            org:  [...document.querySelectorAll('#pp-origin optgroup')].map(g => g.label),
        })""")
        check("目的地がゾーン別にまとまる",
              any('Zone 7' in l for l in grp["dest"]) and len(grp["dest"]) >= 5, str(grp["dest"])[:90])
        check("出発地が地域別にまとまる",
              any('グループ空港' in l for l in grp["org"]), str(grp["org"]))

        pg.select_option("#pp-origin", "HND"); pg.select_option("#pp-dest", "CDG")
        pg.select_option("#pp-arrival", "")
        pg.click("#pp-go"); pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        first = pg.inner_text("#pp-list .pp-city")
        check("「もう1都市なし」が一覧の先頭に行として出る", "もう1都市なし" in first,
              first.replace("\n", " ")[:70])
        pg.click("#pp-list .pp-city")
        pg.wait_for_selector("#pp-s3:not([hidden])", timeout=5000)
        title = pg.inner_text("#pp-s3-title")
        check("「もう1都市なし」を選ぶと旅程画面へ進める", "もう1都市なし" in title, title)

        # じぶんで組む → 提案（経由地も条件にする）
        pg.evaluate("""() => {
            Object.assign(STATE, { awardType:'partner', departure:'HND', destination:'CDG',
              arrival:null, returnDep:null, outbound:['FRA',null,null], return:[null,null,null],
              outboundSO:[false,false,false], returnSO:[false,false,false],
              outboundSurface:[false,false,false], returnSurface:[false,false,false] });
            updateAllDots(); ppGo('editor');
        }""")
        pg.click("button[onclick='ppFromEditor()']")
        pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        pin = pg.inner_text("#pp-cond-pin")
        okvia = pg.evaluate("""() => PP.rows.flatMap(r => r.ways)
            .every(w => JSON.stringify(w.itinerary).includes('FRA'))""")
        check("じぶんで組む画面から提案を受けられる", pg.is_visible("#pp-s2"), None)
        check("置いてある経由地が条件になる", "フランクフルト" in pin and okvia, pin)

        # ══ 特典の種類を3つに分ける（2026-09-19）══════════════════════
        # ①「東京（羽田 / 成田）」を選んでも候補が出ること（以前はどの行き先でも0件だった）
        # ②「提携航空会社 → ベトナム航空」で、成田/羽田→ハノイ→アムステルダムが出ること
        # 直前の検査で「フランクフルトを必ず通る」が条件に残っているので外す
        pg.evaluate("() => { PP.mustVia = []; ppGo('s1'); }")
        pg.select_option("#pp-origin", "TYO")
        pg.select_option("#pp-dest", "AMS")
        pg.select_option("#pp-arrival", "")
        pg.select_option("#pp-award", "star")
        pg.click("#pp-go")
        pg.wait_for_function("PP.req && PP.req.destination === 'AMS' && PP.req.awardKind === 'star'", timeout=60000)
        pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        base_t = pg.inner_text("#pp-base")
        rows_t = pg.eval_on_selector_all("#pp-list .pp-city", "els => els.length")
        check("グループ空港（東京 羽田/成田）発でも基準の旅程が作れる",
              "作れませんでした" not in base_t, base_t.replace("\n", " ")[:80])
        check("グループ空港発でも候補が出る", rows_t >= 1, f"{rows_t}行")
        no_transit = pg.evaluate("""() => PP.rows.concat(PP.base ? [{ways:[PP.base]}] : [])
            .flatMap(r => r.ways)
            .filter(w => [...w.itinerary.outbound, ...w.itinerary.return]
                          .filter(Boolean).some(i => ['TYO','OSA'].includes(i))).length""")
        check("グループ空港を乗り継ぎ地に使わない", no_transit == 0, f"{no_transit}本")

        # 航空会社の欄は「提携航空会社」のときだけ出る
        pg.evaluate("ppGo('s1')")
        check("スタアラでは航空会社の欄を出さない", not pg.is_visible("#pp-airline-field"), None)
        pg.select_option("#pp-award", "partner")
        check("提携航空会社では航空会社の欄が出る", pg.is_visible("#pp-airline-field"), None)
        opts = pg.eval_on_selector_all("#pp-airline option", "els => els.map(e => e.value)")
        check("提携社の一覧が airlines.json から入る", "VN" in opts and "UA" not in opts, str(opts))

        pg.select_option("#pp-airline", "VN")
        pg.click("#pp-go")
        # ★PP.req は propose() を呼ぶ**前**に入るので、これで待つと検索前の結果を読む。
        #   検索が終わった印は PP.stats（propose の戻り値）で取る
        pg.wait_for_function("PP.stats && PP.stats.partnerAirline === 'VN'", timeout=60000)
        vn = pg.evaluate("""() => {
            const ways = PP.rows.concat(PP.base ? [{ways:[PP.base]}] : []).flatMap(r => r.ways);
            const one = ways.find(w => (w.plan ?? '') === 'single:VN');
            if (!one) return null;
            return { plan: one.plan, label: one.planLabel, miles: one.miles,
                     route: one.route.join(' / '),
                     onlyVN: ways.every(w => w.plan === 'single:VN'),
                     carriers: [...new Set(one.carriersByLeg.flatMap(l => l.airlines))] };
        }""")
        check("ベトナム航空だけで組む旅程が出る", vn is not None, str(vn))
        if vn:
            check("全区間がベトナム航空", vn["carriers"] == ["VN"], str(vn["carriers"]))
            check("ハノイ経由になる", "ハノイ" in vn["route"], vn["route"])
            check("他社の案が混ざらない", vn["onlyVN"], str(vn["onlyVN"]))
            check("条件バーに航空会社が出る", "ベトナム" in pg.inner_text("#pp-cond-award"),
                  pg.inner_text("#pp-cond-award"))

        # ══ 動線の穴の是正（2026-09-20・画面遷移マップ ⚠-1〜⚠-4）══
        # ⚠-1 画面に URL が付き、戻る・進む・再読込で復帰できる
        pg.evaluate("() => { PP.mustVia = []; ppGo('s1'); }")
        pg.select_option("#pp-origin", "HND")
        pg.select_option("#pp-dest", "CDG")
        pg.select_option("#pp-award", "star")
        pg.select_option("#pp-arrival", "")
        check("さがす画面のURLは #search", pg.evaluate("location.hash") == "#search",
              pg.evaluate("location.hash"))
        pg.click("#pp-go")
        pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        check("候補へ進むとURLが #candidates になる", pg.evaluate("location.hash") == "#candidates",
              pg.evaluate("location.hash"))
        pg.go_back()
        time.sleep(0.6)
        check("ブラウザの「戻る」でさがす画面に戻る",
              vis("pp-s1") and not vis("pp-s2"), pg.evaluate("location.hash"))
        pg.go_forward()
        time.sleep(0.6)
        check("「進む」で候補に戻る", vis("pp-s2") and not vis("pp-s1"), pg.evaluate("location.hash"))

        # ★再読込：候補は計算結果なので保存されていない。条件から作り直せること
        pg.reload()
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        check("再読込しても候補の画面に戻る（条件から作り直す）",
              vis("pp-s2") and not vis("pp-s1"), pg.evaluate("location.hash"))
        hist = pg.eval_on_selector_all("#pp-list .pp-city", "els => els.length")
        check("作り直した候補が空でない", hist >= 1, f"{hist}行")

        # ⚠-2 「◀ 提案に戻る」が、旅程を経ていないときに空の画面へ落ちない
        pg.evaluate("() => { PP.chosen = null; ppGo('editor'); }")
        time.sleep(0.4)
        pg.click("button[onclick='ppBackFromEditor()']")
        time.sleep(0.5)
        check("旅程を選ばずに「じぶんで組む」へ入っても、空の旅程画面に着地しない",
              vis("pp-s2") and not vis("pp-s3"), pg.evaluate("location.hash"))

        # ⚠-3 さがす画面から「じぶんで組む」へ直接行ける（文言が案内している行き先）
        pg.evaluate("ppGo('s1')")
        time.sleep(0.3)
        has_entry = pg.eval_on_selector_all(
            "#pp-s1 button[onclick=\"ppGo('editor')\"]", "els => els.length")
        check("さがす画面に「じぶんで組む」への入口がある", has_entry == 1, f"{has_entry}件")
        hint = pg.inner_text("#pp-s1")
        check("「下の」という位置の案内が残っていない", "下の「じぶんで組む」" not in hint, None)
        pg.click("#pp-s1 button[onclick=\"ppGo('editor')\"]")
        time.sleep(0.5)
        check("そのボタンで「じぶんで組む」へ行ける", vis("pane-editor"), pg.evaluate("location.hash"))

        # ⚠-4 「特典の種類」と規約の切替が名前で区別できる
        settings = pg.inner_text("#settings-body") if pg.is_visible("#settings-body") else \
            pg.evaluate("document.getElementById('settings-body').innerText")
        check("設定側の見出しが「特典航空券タイプ」ではなくなっている",
              "特典航空券タイプ" not in settings and "どちらの規約で判定するか" in settings,
              settings.replace("\n", " ")[:80])

        check("JSエラーが出ない", len(errors) == 0, " / ".join(errors[:3]))
        b.close()
finally:
    srv.terminate()

ng = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("✅" if ok else "❌") + f" {name}" + (f" — {detail}" if detail else ""))
print(f"\n{len(results) - len(ng)}/{len(results)} PASS")
sys.exit(1 if ng else 0)
