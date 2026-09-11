# 特典カレンダーから出す「取れる日」をブラウザで実測する（S-6）。
#   ../../.venv/bin/python tests/browser_seats.py
# 見たいのは数が出るかではなく、**確認の深さが違うものを混ぜていないか**。
import subprocess, time, sys, os, re
from playwright.sync_api import sync_playwright

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PORT = 8791

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
        pg.goto(f"http://127.0.0.1:{PORT}/index.html")
        pg.wait_for_function("typeof rulesReady !== 'undefined'", timeout=15000)
        pg.evaluate("async () => { await rulesReady; }")

        loaded = pg.evaluate("async () => { await ensureAwardCal(); return !!AWARD_CAL; }")
        check("特典カレンダー(data/award-calendar.json)を読める", loaded is True, str(loaded))
        meta = pg.evaluate("AWARD_CAL && AWARD_CAL._meta")
        check("目安であることがデータに書いてある", bool(meta and meta.get("is_estimate")), str(meta)[:80])

        pg.evaluate("ppGo('s1')")
        pg.select_option("#pp-origin", "HIJ"); pg.select_option("#pp-dest", "CDG")
        pg.select_option("#pp-arrival", "")
        pg.click("#pp-go"); pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        rows = pg.eval_on_selector_all("#pp-list .pp-city", "e=>e.map(x=>x.innerText.replace(/\\n/g,' '))")

        check("取れる日が行に出る", any("取れる日" in r for r in rows), rows[0][:70])
        check("目安であることを画面に書いている",
              "目安であって実在庫ではありません" in pg.inner_text("#pp-foot"))

        # ★往復まで確認できた行が、行きだけしか確認できていない行より上に来る
        full = [i for i, r in enumerate(rows) if "取れる日" in r]
        part = [i for i, r in enumerate(rows) if "帰りは未確認" in r or "行きは未確認" in r]
        check("往復確認できた行が、片道だけの行より上に並ぶ",
              bool(full) and bool(part) and max(full) < min(part),
              f"往復={full[:3]}… 片道={part[:3]}…")
        check("片道だけの行は未確認だと書く",
              all(("未確認" in rows[i]) for i in part), str([rows[i][:50] for i in part[:2]]))

        # ★寄り道すると取れる日が増える（このアプリの主張そのもの）
        base = next((r for r in rows if "もう1都市なし" in r), "")
        m_base = re.search(r"取れる日 (\d+)/", base)
        best = max((int(m.group(1)) for r in rows[1:] if (m := re.search(r"取れる日 (\d+)/", r))), default=0)
        check("寄り道した案のほうが取れる日が多い",
              bool(m_base) and best > int(m_base.group(1)),
              f"まっすぐ={m_base.group(1) if m_base else '?'}日 / 寄り道の最良={best}日")

        # 並び替え
        btns = pg.eval_on_selector_all("#pp-sort .pp-sort-btn", "e=>e.map(x=>x.innerText)")
        check("並び替えを選べる", btns == ["取れる日が多い順", "寄り道が小さい順"], str(btns))
        pg.eval_on_selector_all("#pp-sort .pp-sort-btn", "e=>e[1].click()")
        rows2 = pg.eval_on_selector_all("#pp-list .pp-city", "e=>e.map(x=>x.innerText.replace(/\\n/g,' '))")
        check("並び替えても「もう1都市なし」は先頭のまま", "もう1都市なし" in rows2[0], rows2[0][:50])
        check("並び替えると順番が変わる", rows[1] != rows2[1], f"{rows[1][:24]} → {rows2[1][:24]}")

        # クラスが違うカレンダーを流用しない
        pg.evaluate("ppGo('s1')"); pg.select_option("#pp-cabin", "biz")
        pg.click("#pp-go"); pg.wait_for_selector("#pp-list .pp-city", timeout=60000)
        biz = pg.eval_on_selector_all("#pp-list .pp-city", "e=>e.map(x=>x.innerText)")
        check("ビジネスの検索にエコノミーの表を流用しない",
              not any("取れる日" in r for r in biz), biz[0].replace("\n", " ")[:60])

        check("JSエラーなし", not errors, str(errors[:3]))
        b.close()
finally:
    srv.terminate()

ok = sum(1 for _, r, _ in results if r)
for name, r, detail in results:
    print(f"{'✅' if r else '❌'} {name}" + (f"  — {detail}" if detail and not r else ""))
print(f"\n{ok}/{len(results)} PASS")
sys.exit(0 if ok == len(results) else 1)
