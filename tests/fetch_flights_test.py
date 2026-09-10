#!/usr/bin/env python3
"""S-4 実便取得のパーサ検査。

    projects/my8flyer/.venv-flights/bin/python projects/my8flyer/tests/fetch_flights_test.py

Google の生レスポンスは1.9MBあり、公開リポジトリに他社のHTMLを置きたくないので
**同じ形の最小データを自分で組んで**当てる。実データでの確認は smoke（実行ログ）側で行う。

ここで守りたいのは1点だけ：**並びが変わったときに黙って0件を返さないこと**。
「取れなかった」は画面に出せるが、「取れたつもりで中身が違う」は誰も気づかない。
"""

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts" / "my8flyer"))
from fetch_flights import ShapeChanged, parse_nonstop  # noqa: E402

FAIL = []


def check(name, fn):
    try:
        fn()
        print(f"  ✅ {name}")
    except AssertionError as e:
        FAIL.append(name)
        print(f"  ❌ {name}: {e}")
    except Exception as e:  # noqa: BLE001
        FAIL.append(name)
        print(f"  ❌ {name}: 想定外 {type(e).__name__}: {e}")


def segment(frm="HND", to="FRA", dep=(10, 40), arr=(17, 30), dur=890,
            carrier=("NH", "223", None, "ANA"), codeshares=None,
            aircraft="Boeing 787", dep_date=(2026, 10, 25), arr_date=(2026, 10, 25)):
    """実測した並び（sf[0..22]）と同じ形の1区間を作る。"""
    sf = [None] * 23
    sf[3], sf[4], sf[5], sf[6] = frm, "出発空港", "到着空港", to
    sf[8], sf[10], sf[11] = list(dep), list(arr), dur
    sf[15] = codeshares if codeshares is not None else []
    sf[17] = aircraft
    sf[20], sf[21] = list(dep_date), list(arr_date)
    sf[22] = list(carrier)
    return sf


def html_of(itineraries, block=3, extra=None):
    """便の一覧を payload[block][0] に差した最小の ds:1 スクリプトを組む。

    block=2 は「おすすめのフライト」・block=3 は「その他のフライト」。
    extra は {位置: 値} で、読み取り対象外の場所に便を置きたいとき用。
    """
    payload = [None] * 8
    payload[block] = [itineraries]
    payload[7] = [None, [[], []]]
    for i, v in (extra or {}).items():
        payload[i] = v
    body = json.dumps(payload, ensure_ascii=False)
    return f'<html><body><script class="ds:1">AF_initDataCallback({{key:1, data:{body}, sideChannel:{{}}}});</script></body></html>'


def itinerary(segments):
    return [[None, None, segments], [[None, 300000]]]


# --- 正常系 ---------------------------------------------------------------
def t_ok():
    r = parse_nonstop(html_of([itinerary([segment()])]), "HND", "FRA")
    assert len(r) == 1, r
    f = r[0]
    assert f["flight_no"] == "NH223", f
    assert f["carrier"] == "NH" and f["carrier_name"] == "ANA", f
    assert f["dep"] == "10:40" and f["arr"] == "17:30", f
    assert f["duration_min"] == 890 and f["aircraft"] == "Boeing 787", f
    assert f["arr_next_day"] is False, f


def t_codeshare():
    r = parse_nonstop(html_of([itinerary([segment(codeshares=[["LH", "4919", None, "ルフトハンザ"]])])]),
                      "HND", "FRA")
    assert r[0]["codeshares"] == ["LH4919"], r[0]


def t_next_day():
    r = parse_nonstop(html_of([itinerary([segment(dep=(22, 45), arr=(5, 30),
                                                  arr_date=(2026, 10, 26))])]), "HND", "FRA")
    assert r[0]["arr_next_day"] is True, r[0]


def t_zero_padding():
    """Google は 0 の要素を落とす。[None, 31] は 00:31。"""
    r = parse_nonstop(html_of([itinerary([segment(dep=[None, 31], arr=[8])])]), "HND", "FRA")
    assert r[0]["dep"] == "00:31" and r[0]["arr"] == "08:00", r[0]


def t_dedupe_by_flight_no():
    """同じ便が運賃ちがいで複数並ぶ。便名で1本に畳む。"""
    it = [itinerary([segment()]), itinerary([segment()]),
          itinerary([segment(carrier=("NH", "203", None, "ANA"), dep=(22, 45))])]
    r = parse_nonstop(html_of(it), "HND", "FRA")
    assert [f["flight_no"] for f in r] == ["NH223", "NH203"], r   # 出発順


def t_no_flights_is_not_an_error():
    payload = [None] * 8
    payload[3] = [None]
    body = json.dumps(payload)
    h = f'<html><script class="ds:1">AF_initDataCallback({{data:{body},x:1}});</script></html>'
    assert parse_nonstop(h, "HND", "FRA") == []


def t_connecting_is_skipped():
    """max_stops=0 で頼んでいるので、2区間の旅程は数えない。"""
    r = parse_nonstop(html_of([itinerary([segment(), segment(frm="FRA", to="CDG")])]), "HND", "FRA")
    assert r == [], r


def t_both_blocks_are_read():
    """★便の一覧は payload[2]（おすすめ）と payload[3]（その他）に分かれて入る。

    実測：HND→LHR 2026-10-25 は全5便のうち NH211 を含む3便が payload[2] にいた。
    payload[3] だけを読むと2便しか取れず、しかも**件数は返るので誰も気づかない**。
    """
    payload = [None] * 8
    payload[2] = [[itinerary([segment(carrier=("NH", "211", None, "ANA"), dep=(10, 5))])]]
    payload[3] = [[itinerary([segment(carrier=("BA", "6", None, "BA"), dep=(13, 15))]),
                   itinerary([segment(carrier=("JL", "41", None, "JAL"), dep=(1, 0))])]]
    payload[7] = [None, [[], []]]
    body = json.dumps(payload, ensure_ascii=False)
    h = f'<html><script class="ds:1">AF_initDataCallback({{data:{body},x:1}});</script></html>'
    r = parse_nonstop(h, "HND", "FRA")
    assert [f["flight_no"] for f in r] == ["JL41", "NH211", "BA6"], r   # 出発順


# --- 形が変わったら止まる（ここが本体）------------------------------------


def t_missed_flight_stops():
    """読み取り対象外の位置に便がいたら止める（黙って少なく返さない）。"""
    hidden = [[itinerary([segment(carrier=("NH", "211", None, "ANA"))])]]
    h = html_of([itinerary([segment(carrier=("BA", "6", None, "BA"))])], extra={5: hidden})
    expect_shape_changed(h)
def expect_shape_changed(h, frm="HND", to="FRA"):
    try:
        parse_nonstop(h, frm, to)
    except ShapeChanged:
        return
    raise AssertionError("ShapeChanged が投げられず、黙って通った")


def t_wrong_airport_stops():
    """頼んだ区間と違うものが返ってきたら止める（件数だけ見て安心しない）。"""
    expect_shape_changed(html_of([itinerary([segment(frm="NRT")])]))


def t_short_segment_stops():
    it = [[[None, None, [[None] * 10]], [[None, 300000]]]]
    expect_shape_changed(html_of(it))


def t_carrier_moved_stops():
    """運航会社・便名の位置がズレたら止める。"""
    sf = segment()
    sf[22] = ["ANA", "羽田"]          # 社コード2文字・便名が数字、を満たさない
    expect_shape_changed(html_of([itinerary([sf])]))


def t_airport_code_moved_stops():
    sf = segment()
    sf[3] = "羽田空港"                 # IATA3文字でない
    expect_shape_changed(html_of([itinerary([sf])]))


def t_no_ds1_stops():
    expect_shape_changed("<html><body>お使いのブラウザは…</body></html>")


def t_truncated_payload_stops():
    body = json.dumps([None, None])
    expect_shape_changed(f'<html><script class="ds:1">AF_initDataCallback({{data:{body},x:1}});</script></html>')


if __name__ == "__main__":
    print("S-4 実便パーサ")
    for name, fn in sorted(globals().items()):
        if name.startswith("t_"):
            check(name[2:], fn)
    total = len([n for n in globals() if n.startswith("t_")])
    print(f"\n{total - len(FAIL)}/{total} PASS" + (f" — 失敗: {FAIL}" if FAIL else ""))
    sys.exit(1 if FAIL else 0)
