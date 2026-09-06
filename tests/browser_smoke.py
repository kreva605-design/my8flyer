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
        pg.wait_for_function("window.RULES_CFG !== null || window.RULES_LOAD_ERROR !== null", timeout=10000)

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
