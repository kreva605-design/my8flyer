# index.html を実際にブラウザで開き、規約データの読み込みと判定を実測する
import subprocess, time, json, sys, os
from playwright.sync_api import sync_playwright

# このファイル（tests/）の1つ上＝プロジェクト直下を配信する。
# 絶対パスを書かない（このリポジトリは GitHub Pages で公開されるため）
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
        # ★ window.RULES_CFG では待てない（トップレベルの let は window に生えないため常に undefined ≠ null）。
        # 読み込みの完了そのものを待つ
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.evaluate("async () => { await rulesReady; }")

        cfg = pg.evaluate("RULES_CFG")
        results.append(("規約データ読み込み", cfg is not None, json.dumps(
            {"partner": cfg and cfg["partner"], "ana": cfg and cfg["ana"]}, ensure_ascii=False)))

        def judge(state, award="partner"):
            return pg.evaluate("""async ([st, aw]) => {
                Object.assign(STATE, {
                  awardType: aw, departure:null, destination:null, arrival:null, returnDep:null,
                  outbound:[null,null,null], return:[null,null,null],
                  outboundSO:[false,false,false], returnSO:[false,false,false],
                  outboundSurface:[false,false,false], returnSurface:[false,false,false],
                }, st);
                await validate();
                return {
                  summary: document.getElementById('result-summary').innerText,
                  checks: document.getElementById('check-results').innerText,
                  counter: document.getElementById('transit-counter')?.innerText ?? '',
                };
            }""", [state, award])

        r = judge({"departure": "HIJ", "destination": "CDG", "outbound": ["HND", None, None]})
        results.append(("広島→パリ・羽田1回経由は合格", "問題ありません" in r["summary"], r["summary"].replace("\n", " / ")))

        r = judge({"departure": "HIJ", "destination": "CDG", "outbound": ["ITM", "HND", None]})
        ok = "ルール違反があります" in r["summary"] and "日本国内 2/1" in r["checks"]
        results.append(("国内乗り換え2回は不合格", ok, [l for l in r["checks"].split("\n") if "乗り換え" in l]))

        r = judge({"departure": "HIJ", "destination": "CDG",
                   "outbound": ["HND", "NRT", None], "outboundSurface": [True, False, False]})
        results.append(("地上移動でつなげば合格", "問題ありません" in r["summary"], r["summary"].replace("\n", " / ")))

        r = judge({"departure": "HND", "destination": "CDG", "outbound": ["ICN", None, None]}, "ana")
        results.append(("ANA自社便で海外乗換は不合格", "日本以外の乗り換えはできません" in r["checks"], None))

        # 陸路移動を画面から立てられるか（S-5 で追加した導線）。
        # 判定側は前から対応していたが、UI が無いため使えなかった
        pg.evaluate("""() => {
            Object.assign(STATE, {
              awardType:'partner', departure:'HIJ', destination:'CDG', arrival:null, returnDep:null,
              outbound:['HND','NRT',null], return:[null,null,null],
              outboundSO:[false,false,false], returnSO:[false,false,false],
              outboundSurface:[false,false,false], returnSurface:[false,false,false],
            });
            updateAllDots();
            openModal('out-0');
        }""")
        shown = pg.is_visible("#surface-row")
        pg.check("#surface-chk")
        pg.click("button.btn-close")
        note = pg.inner_text("#surface-note")
        st   = pg.evaluate("STATE.outboundSurface")
        results.append(("乗り継ぎ地に陸路移動の切り替えが出る", shown, None))
        results.append(("陸路にすると機体図の下に出る", "陸路で移動" in note, note))
        results.append(("陸路の指定が状態に入る", st == [True, False, False], str(st)))

        r = pg.evaluate("""async () => {
            await validate();
            return document.getElementById('result-summary').innerText;
        }""")
        results.append(("陸路でつなげば国内2回でも合格になる（判定と導線がつながる）",
                        "問題ありません" in r, r.replace("\n", " / ")))

        # 必要マイルの表示が公式チャート（miles-core）から来ているか。
        # 2026-09-07 まで index.html が持っていた表は、ビジネスが全ゾーンで過大だった
        #（羽田→パリ ビジネス：旧 140,000 ／ 公式 115,000）
        judge({"departure": "HND", "destination": "CDG"})
        pg.wait_for_function(
            "document.getElementById('mile-info').innerText.includes('マイル')", timeout=10000)
        mi = pg.evaluate("document.getElementById('mile-info').innerText").replace("\n", " / ")
        results.append(("必要マイルが公式チャートの値になる（羽田→パリ）",
                        "55,000" in mi and "115,000" in mi and "140,000" not in mi, mi[:150]))

        # 台北はエコノミーも違っていた（旧 24,630 ／ 公式 20,000）
        judge({"departure": "HND", "destination": "TPE"})
        pg.wait_for_function(
            "document.getElementById('mile-info').innerText.includes('マイル')", timeout=10000)
        mi = pg.evaluate("document.getElementById('mile-info').innerText").replace("\n", " / ")
        results.append(("必要マイルが公式チャートの値になる（羽田→台北）",
                        "20,000" in mi and "24,630" not in mi, mi[:120]))

        # 乗り換えカウンタの上限表示が規約データ（国内1・海外2）から来ているか
        pg.evaluate("STATE.awardType='partner'; STATE.outbound=[null,null,null]; STATE.return=[null,null,null]; applyAwardTypeUI();")
        cnt = pg.evaluate("document.getElementById('transit-counter')?.innerText ?? ''").replace("\n", " ")
        ok = cnt.count("0/1") == 2 and cnt.count("0/2") == 2
        results.append(("カウンタの上限が規約データ由来（国内1・海外2）", ok, cnt))

        # 規約データが読めなかったときに「問題ありません」を出さないこと（fail-safe）
        r = pg.evaluate("""async () => {
            const keep = RULES_CFG; RULES_CFG = null;
            await validate();
            const out = document.getElementById('result-summary').innerText;
            RULES_CFG = keep;
            return out;
        }""")
        ok = ("読み込めませんでした" in r) and ("問題ありません" not in r)
        results.append(("規約データが無いときは判定せず止まる", ok, r.replace("\n", " / ")))

        # Googleフライトのリンクに「その区間で乗れる社」が入るか（2026-09-10）
        pg.evaluate("""async () => {
            Object.assign(STATE, { awardType:'partner', departure:'HND', destination:'CDG',
              arrival:null, returnDep:null, outbound:[null,null,null], return:[null,null,null],
              outboundSO:[false,false,false], returnSO:[false,false,false],
              outboundSurface:[false,false,false], returnSurface:[false,false,false] });
            updateAllDots(); await validate();
            if (typeof ppGo === 'function') ppGo('editor');   // 提案画面ではなく編集画面を出す
        }""")
        pg.wait_for_selector("a.gf-link", state="attached", timeout=20000)
        href = pg.get_attribute("a.gf-link", "href")
        from urllib.parse import unquote
        q = unquote(href.split("q=")[1])
        results.append(("Googleフライトのリンクに乗れる社が入る",
                        " on " in q and "HND" in q and "CDG" in q, q))

        results.append(("JSエラーなし", len(errors) == 0, errors))
        b.close()
finally:
    srv.terminate()

fail = 0
for name, ok, detail in results:
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"\n        {detail}"))
    if not ok: fail += 1
    if ok and detail: print(f"        {detail}")
print(f"\n{len(results)-fail}/{len(results)} PASS")
sys.exit(1 if fail else 0)
