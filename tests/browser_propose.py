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

        # ===== 曜日を考慮した提案（REQ-104〜106）=====
        wk = pg.evaluate("""
            () => {
              const ways = PP.rows.flatMap(r => r.ways);
              const withW = ways.filter(w => w.weekdays);
              return {
                ways: ways.length,
                withW: withW.length,
                shapeOk: withW.every(w => /^[01?]{7}$/.test(w.weekdays.days)),
                daily: withW.filter(w => w.weekdays.days === '1111111').length,
                unsure: withW.filter(w => w.weekdays.unsure).length,
              };
            }
        """)
        check("候補に曜日が付いている（REQ-104）",
              wk["withW"] == wk["ways"] and wk["ways"] > 0 and wk["shapeOk"], str(wk))
        check("曜日の帯が画面に出る",
              pg.eval_on_selector_all("#pp-list .pp-wd", "e => e.length") >= 1,
              f'{pg.eval_on_selector_all("#pp-list .pp-wd", "e => e.length")}個')
        check("未確認は「飛ばない」と書かず、未確認と書く",
              pg.evaluate("""() => {
                  const t = [...document.querySelectorAll('#pp-list .pp-wd.unsure')]
                            .map(e => e.textContent);
                  return t.length === 0 || t.every(x => x.includes('未確認'));
              }"""), f'未確認の帯 {wk["unsure"]}件')

        # 絞り込み（REQ-105）。**未確認を理由に候補を消さない**
        check("曜日の絞り込みが出る",
              not pg.is_hidden("#pp-wday")
              and pg.eval_on_selector_all("#pp-wday select", "e => e.length") == 1,
              pg.inner_text("#pp-wday").replace("\n", " ")[:80])
        before = pg.eval_on_selector_all("#pp-list .pp-city", "e => e.length")
        drop = pg.evaluate("""
            () => {
              // 「その曜日に飛ばないと分かっている案だけの都市」がある曜日を探す
              for (let d = 0; d < 7; d++) {
                const hit = PP.rows.filter(r => r.ways.some(w => PP.mod.flysOn(w.weekdays, d)));
                if (hit.length < PP.rows.length) return { d, hit: hit.length, all: PP.rows.length };
              }
              return null;
            }
        """)
        # ★「未確認を消していないか」は、未確認が実際に出る曜日で確かめる。
        #   月曜は全区間が観測済み（seen の1日目）なので ? が1つも無く、その曜日で検査すると
        #   前提0件のまま素通りしてしまう
        unsure_day = pg.evaluate("""
            () => {
              for (let d = 0; d < 7; d++) {
                const n = PP.rows.filter(r =>
                  r.ways.some(w => w.weekdays && w.weekdays.days[d] === '?')).length;
                if (n > 0) return { d, n };
              }
              return null;
            }
        """)
        WJA = "月火水木金土日"
        if drop:
            pg.select_option("#pp-wday-sel", str(drop["d"]))
            after = pg.eval_on_selector_all("#pp-list .pp-city", "e => e.length")
            check("曜日でしぼると、飛ばないと分かっている案が隠れる（REQ-105）",
                  after < before, f'{before}行 → {after}行（{WJA[drop["d"]]}曜）')
            pg.select_option("#pp-wday-sel", "")
            check("「指定なし」に戻すと元の件数に戻る",
                  pg.eval_on_selector_all("#pp-list .pp-city", "e => e.length") == before,
                  f'{before}行')
        else:
            check("曜日でしぼると、飛ばないと分かっている案が隠れる（REQ-105）",
                  False, "全曜日で差が出ない＝検査の前提が崩れた（データを疑う）")

        if unsure_day:
            # ★比べるのは「しぼり込む前に画面へ出ていた行」。PP.rows には大回りで
            #   畳まれている行も入っており、それを母数にすると曜日と関係ない差が出る
            shown_before = pg.eval_on_selector_all(
                "#pp-list .pp-city", "es => es.map(e => e.textContent)")
            pg.select_option("#pp-wday-sel", str(unsure_day["d"]))
            kept = pg.evaluate("""
                ([d, before]) => {
                  const shown = [...document.querySelectorAll('#pp-list .pp-city')]
                    .map(e => e.textContent);
                  const unsureRows = PP.rows.filter(r =>
                    r.ways.some(w => w.weekdays && w.weekdays.days[d] === '?'));
                  // しぼり込む前に出ていて、その曜日が未確認の行
                  const need = unsureRows.filter(r => before.some(t => t.includes(r.city)));
                  return {
                    need: need.length,
                    kept: need.filter(r => shown.some(t => t.includes(r.city))).length,
                  };
                }
            """, [unsure_day["d"], shown_before])
            check("未確認を含む候補は、しぼり込んでも1つも消さない（REQ-105）",
                  kept["need"] > 0 and kept["kept"] == kept["need"],
                  f'{WJA[unsure_day["d"]]}曜が未確認の都市 {kept["need"]} → 画面に残った {kept["kept"]}')
            pg.select_option("#pp-wday-sel", "")
        else:
            check("未確認を含む候補は、しぼり込んでも1つも消さない（REQ-105）",
                  False, "未確認の候補が1つも無い＝検査の前提が崩れた（データを疑う）")

        check("曜日は目安だと書いてある（REQ-106）",
              "目安" in foot and "特典の空席ではありません" in foot
              and "つながる便の組み合わせ" in foot, foot.replace("\n", " ")[-120:])

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

        # ══ 画面を往復しても「特典の種類」を保つ（2026-09-20・REQ-95／96）══
        # ★契機＝提携航空会社（ベトナム航空）で探した旅程を「じぶんで組む」へ読み込み、
        #   「この条件でもう1都市の提案を受ける」を押すと、スターアライアンス便の候補が出ていた。
        #   3択（star/partner/ana）を規約2値に畳んで戻すときに、社の指定ごと落ちていた
        pg.evaluate("() => { PP.mustVia = []; PP.chosen = null; ppGo('s1'); }")
        pg.select_option("#pp-origin", "TYO")
        pg.select_option("#pp-dest", "AMS")
        pg.select_option("#pp-arrival", "")
        pg.select_option("#pp-award", "partner")
        pg.wait_for_selector("#pp-airline option[value='VN']", state="attached", timeout=10000)
        pg.select_option("#pp-airline", "VN")
        pg.click("#pp-go")
        pg.wait_for_function("PP.stats && PP.stats.partnerAirline === 'VN'", timeout=60000)

        opened = pg.evaluate("""() => {
            const r = PP.rows.find(x => x.iata === 'HAN') ?? PP.rows[0];
            PP.selKey = (r.iata ?? '__base__') + '|' + (r.plan ?? '-'); PP.way = 0; ppRender();
            ppShowItinerary(r.ways[0]);
            return { city: r.city, plan: r.plan };
        }""")
        check("提携1社の旅程を開ける", opened and opened.get("plan") == "single:VN", str(opened))

        pg.evaluate("() => ppToEditor()")
        pg.wait_for_selector("#pane-editor:not([hidden])", timeout=5000)
        st = pg.evaluate("() => ({ kind: STATE.awardKind, air: STATE.partnerAirline })")
        check("じぶんで組むへ渡すとき特典の種類と社を持ち帰る",
              st == {"kind": "partner", "air": "VN"}, str(st))

        pg.evaluate("async () => { await ppFromEditor(); }")
        back = pg.evaluate("""() => ({
            kind: PP.req.awardKind, air: PP.req.partnerAirline,
            dom: document.getElementById('pp-award').value,
            domAir: document.getElementById('pp-airline').value,
            chip: ppAwardChipLabel(),
            mustVia: PP.req.mustVia ?? [],
            plans: [...new Set(PP.rows.map(r => r.plan))]
        })""")
        check("もう1都市の提案を受け直しても提携1社のまま",
              back["kind"] == "partner" and back["air"] == "VN", str(back)[:120])
        check("画面の「特典の種類」と航空会社も戻っている",
              back["dom"] == "partner" and back["domAir"] == "VN",
              f'{back["dom"]}/{back["domAir"]}')
        check("条件バーに社名が出る", "ベトナム" in back["chip"], back["chip"])
        check("スターアライアンスの案が混ざらない",
              back["plans"] == ["single:VN"], str(back["plans"]))
        check("経由地の条件が重複しない（ハノイ・ハノイにならない）",
              len(back["mustVia"]) == len(set(back["mustVia"])), str(back["mustVia"]))

        # 旅程を開かずに「じぶんで組む」へ入ったときも、直前に実行した検索の条件で戻る
        # （STATE への同期を ppToEditor だけに置くと、ここで前回の条件が残る）
        pg.evaluate("() => { PP.mustVia = []; ppGo('s1'); }")
        pg.select_option("#pp-award", "star")
        pg.click("#pp-go")
        pg.wait_for_function("PP.stats && !PP.stats.partnerAirline", timeout=60000)
        pg.evaluate("async () => { ppGo('editor'); await ppFromEditor(); }")
        skip = pg.evaluate("() => ({ kind: PP.req.awardKind, air: PP.req.partnerAirline })")
        check("旅程を開かずにじぶんで組むへ入っても、直前の検索条件で戻る",
              skip == {"kind": "star", "air": None}, str(skip))

        # 規約を全5条（ANA便のみ）に変えたら、特典の種類もANA便のみへ揃える
        pg.evaluate("""async () => {
            PP.mustVia = []; STATE.awardType = 'ana'; await ppFromEditor();
        }""")
        ana = pg.evaluate("() => ({ kind: PP.req.awardKind, dom: document.getElementById('pp-award').value })")
        check("規約をANA便のみにしたら特典の種類もANA便のみになる",
              ana == {"kind": "ana", "dom": "ana"}, str(ana))

        # 旅程を経ずに入った場合（保存ルートの読込など）は、画面にいまある選択を上書きしない
        pg.evaluate("""() => {
            STATE.awardType = 'partner'; STATE.awardKind = null; STATE.partnerAirline = null;
            PP.mustVia = [];
            document.getElementById('pp-award').value = 'partner';
            ppAwardChange();
        }""")
        pg.wait_for_selector("#pp-airline option[value='VN']", state="attached", timeout=10000)
        pg.evaluate("""async () => {
            document.getElementById('pp-airline').value = 'VN';
            await ppFromEditor();
        }""")
        keep = pg.evaluate("() => ({ kind: PP.req.awardKind, air: PP.req.partnerAirline })")
        check("手がかりが無いときは画面の選択を既定で上書きしない",
              keep == {"kind": "partner", "air": "VN"}, str(keep))

        # ══ オープンジョー（帰りに出発する場所）＝規約第6条（2026-09-21・REQ-97〜99）══
        pg.evaluate("() => { PP.mustVia = []; PP.chosen = null; ppGo('s1'); }")
        pg.select_option("#pp-origin", "TYO")
        pg.select_option("#pp-dest", "AMS")
        pg.select_option("#pp-arrival", "")
        pg.select_option("#pp-award", "star")
        pg.wait_for_function("document.querySelectorAll('#pp-return-dep option').length > 1", timeout=10000)
        opts = pg.eval_on_selector_all("#pp-return-dep option", "e => e.map(x => x.value)")
        check("復路出発地は目的地と同じエリアだけ出す（第6条）",
              "CDG" in opts and "HAN" not in opts and "AMS" not in opts,
              f"{len(opts)}件 CDG={'CDG' in opts} HAN={'HAN' in opts}")

        pg.select_option("#pp-dest", "HAN")
        pg.wait_for_function(
            "[...document.querySelectorAll('#pp-return-dep option')].every(o => o.value !== 'CDG')",
            timeout=10000)
        opts2 = pg.eval_on_selector_all("#pp-return-dep option", "e => e.map(x => x.value)")
        check("目的地を変えると選べる街も入れ替わる", "SIN" in opts2 and "CDG" not in opts2,
              f"{len(opts2)}件 SIN={'SIN' in opts2}")

        # エリア外になった選択は「目的地と同じ」へ戻す（黙って効かせ続けない）
        pg.select_option("#pp-dest", "AMS")
        pg.wait_for_function("[...document.querySelectorAll('#pp-return-dep option')].some(o => o.value === 'CDG')", timeout=10000)
        pg.select_option("#pp-return-dep", "CDG")
        pg.select_option("#pp-dest", "HAN")
        pg.wait_for_function("document.getElementById('pp-return-dep').value === ''", timeout=10000)
        check("エリア外になった指定は目的地と同じへ戻る",
              pg.input_value("#pp-return-dep") == "", pg.input_value("#pp-return-dep"))

        pg.select_option("#pp-dest", "AMS")
        pg.wait_for_function("[...document.querySelectorAll('#pp-return-dep option')].some(o => o.value === 'CDG')", timeout=10000)
        pg.select_option("#pp-return-dep", "CDG")
        pg.evaluate("() => { PP.stats = null; }")   # ★前の検索の結果を読まないよう消してから押す
        pg.click("#pp-go")
        pg.wait_for_function("PP.stats", timeout=60000)
        oj = pg.evaluate("""() => ({
            rd: PP.req.returnDep, chip: document.getElementById('pp-cond-pin').textContent,
            ret: PP.base ? PP.base.route[1] : null, rows: PP.rows.length
        })""")
        check("復路出発地が検索条件に載る", oj["rd"] == "CDG", str(oj)[:110])
        check("条件バーに「パリ発で帰る」と出る", "パリ発で帰る" in oj["chip"], oj["chip"])
        check("基準の旅程がパリ発になる", (oj["ret"] or "").startswith("パリ"), str(oj["ret"]))

        # 再読込（REQ-91 の復元）でも条件が残る
        pg.reload()
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.wait_for_function("PP.stats", timeout=60000)
        check("再読込しても復路出発地が残る", pg.evaluate("() => PP.req.returnDep") == "CDG",
              str(pg.evaluate("() => PP.req.returnDep")))

        # じぶんで組むを往復しても残る（REQ-98）
        pg.evaluate("""() => { const r = PP.rows[0];
            PP.selKey = (r.iata ?? '__base__') + '|' + (r.plan ?? '-'); PP.way = 0; ppRender();
            ppShowItinerary(r.ways[0]); ppToEditor(); }""")
        check("じぶんで組むへ渡すとき復路出発地を持ち帰る",
              pg.evaluate("() => STATE.returnDep") == "CDG", str(pg.evaluate("() => STATE.returnDep")))
        pg.evaluate("async () => { PP.mustVia = []; await ppFromEditor(); }")
        check("もう1都市の提案を受け直しても復路出発地が残る",
              pg.evaluate("() => PP.req.returnDep") == "CDG", str(pg.evaluate("() => PP.req.returnDep")))

        # 第6条を満たさない指定を持ち込んだら、黙って外さず理由を出して止める
        pg.evaluate("async () => { STATE.returnDep = 'HAN'; PP.mustVia = []; await ppFromEditor(); }")
        ng = pg.evaluate("""() => ({ msg: document.getElementById('pp-msg').textContent,
            s1: !document.getElementById('pp-s1').hidden })""")
        check("エリア違いの指定は検索せず理由を出す",
              "第6条" in ng["msg"] and "ハノイ" in ng["msg"] and ng["s1"], ng["msg"][:80])

        # 0件になったら、外してさがし直すボタンを出す（REQ-99）
        pg.evaluate("() => { STATE.returnDep = null; ppGo('s1'); }")
        pg.select_option("#pp-award", "partner")
        pg.wait_for_selector("#pp-airline option[value='VN']", state="attached", timeout=10000)
        pg.select_option("#pp-airline", "VN")
        pg.wait_for_function("[...document.querySelectorAll('#pp-return-dep option')].some(o => o.value === 'LIS')", timeout=10000)
        pg.select_option("#pp-return-dep", "LIS")
        pg.evaluate("() => { PP.stats = null; }")
        pg.click("#pp-go")
        pg.wait_for_function("PP.stats && PP.req.returnDep === 'LIS'", timeout=60000)
        empty = pg.inner_text("#pp-list")
        # 経由地の条件も効いている状態＝2つとも挙げて、2つとも外せること
        check("0件のとき、効いている条件を全部挙げる",
              "リスボン" in empty and "フランクフルト" in empty, empty.replace("\n", " ")[:90])
        check("0件のとき、条件ごとに外すボタンを出す",
              pg.eval_on_selector_all("#pp-list button", "e => e.length") == 2,
              str(pg.eval_on_selector_all("#pp-list button", "e => e.map(x => x.textContent)")))

        pg.click("#pp-list button[onclick='ppClearVia()']")
        pg.wait_for_function("!PP.req.mustVia", timeout=60000)
        only = pg.inner_text("#pp-list")
        check("片方を外しても、残っている条件は挙げ続ける",
              "リスボン" in only and "フランクフルト" not in only, only.replace("\n", " ")[:90])

        pg.click("#pp-list button[onclick='ppClearReturnDep()']")
        pg.wait_for_function("!PP.req.returnDep && PP.rows.length > 0", timeout=60000)
        check("最後の条件を外すと候補が出る",
              pg.eval_on_selector_all("#pp-list .pp-city", "e => e.length") >= 1,
              f'{pg.eval_on_selector_all("#pp-list .pp-city", "e => e.length")}行')

        check("JSエラーが出ない", len(errors) == 0, " / ".join(errors[:3]))
        b.close()
finally:
    srv.terminate()

ng = [r for r in results if not r[1]]
for name, ok, detail in results:
    print(("✅" if ok else "❌") + f" {name}" + (f" — {detail}" if detail else ""))
print(f"\n{len(results) - len(ng)}/{len(results)} PASS")
sys.exit(1 if ng else 0)
