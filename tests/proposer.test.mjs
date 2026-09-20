// =====================================================================
// miles-core / proposer の単体テスト（node --test で実行）
//   cd projects/my8flyer && node --test tests/proposer.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { CITIES, ALL_CARRIERS, AIRLINES, CHARTS, buildRules, loadRoutes, readJson } from './_load.mjs';
import { requiredMiles, japanZoneKey } from '../src/miles-core.js';
import {
  buildGraph, propose, allowedCarriers, hubScore, carrierPlans,
  evaluateItinerary, evaluateByKind, planLabel, groupByCity, soleCarrierOf } from '../src/proposer.js';
import { validateItinerary, ZONE_RANK } from '../src/rules-core.js';

const rules = buildRules();
const ROUTES = loadRoutes();
const graph = buildGraph(ROUTES, CITIES, { carriers: ALL_CARRIERS });
const COORDS = readJson('data/airports.json').airports;
const ctx    = { rules, charts: CHARTS, cities: CITIES, graph, airlines: AIRLINES };
// 既定では帰着地を変える案（国内オープンジョー）を列挙しない。
// 目的の絞れたテストを速く回すため。必要なテストだけ明示的に有効にする
const NO_OJ = { domesticOpenJaw: false };

// 同じ街の別空港（羽田と成田、関空と伊丹と神戸）は同じ都市として扱う。
// 提案側と同じ数え方でないと、テストだけが別の結論を出す
const SAME_CITY = new Map();
CITIES.forEach((c) => (c.group ?? []).forEach((m) => SAME_CITY.set(m, c.iata)));
const cityKey = (iata) => SAME_CITY.get(iata) ?? iata;          // 座標なし（従来の並び）
const ctxGeo = { ...ctx, coords: COORDS };                                 // 座標あり（遠回りで並べる）

function itin(o = {}) {
  return {
    departure: null, destination: null, arrival: null, returnDep: null,
    outbound: [null, null, null], return: [null, null, null],
    outboundSO: [false, false, false], returnSO: [false, false, false],
    outboundSurfaceAfter: [false, false, false], returnSurfaceAfter: [false, false, false],
    ...o,
  };
}
const miles = (o, opts = {}) =>
  requiredMiles(itin(o), { charts: CHARTS, cities: CITIES, ...opts });

// =====================================================================
// 1. 必要マイル — 日本の Zone 1-A / 1-B の切り分け
// =====================================================================

test('国内で乗り継ぐだけの往復は Zone 1-A', () => {
  const it = itin({ departure: 'HIJ', destination: 'CDG', outbound: ['HND', null, null] });
  assert.equal(japanZoneKey(it, CITIES), '1-A');
  assert.equal(miles({ departure: 'HIJ', destination: 'CDG', outbound: ['HND', null, null] }).miles, 55000);
});

test('海外で乗り継ぐと Zone 1-B になり必要マイルが増える', () => {
  const it = itin({ departure: 'HIJ', destination: 'CDG', outbound: ['HND', 'FRA', null] });
  assert.equal(japanZoneKey(it, CITIES), '1-B');
  assert.equal(miles({ departure: 'HIJ', destination: 'CDG', outbound: ['HND', 'FRA', null] }).miles, 62000);
});

test('途中降機があれば国内だけでも Zone 1-B（判断に迷うときは高い側へ）', () => {
  const o = { departure: 'HIJ', destination: 'CDG', outbound: ['HND', null, null], outboundSO: [true, false, false] };
  assert.equal(japanZoneKey(itin(o), CITIES), '1-B');
  assert.equal(miles(o).miles, 62000);
});

test('出発地と帰着地が違えば Zone 1-B（往復2区間ではない）', () => {
  const o = { departure: 'HIJ', destination: 'CDG', arrival: 'HND' };
  assert.equal(japanZoneKey(itin(o), CITIES), '1-B');
});

test('オープンジョーは各ゾーンの必要マイルの半分ずつを合算する', () => {
  // 往路パリ（Zone7）・復路シンガポール発（Zone4）
  const o = { departure: 'HND', destination: 'CDG', returnDep: 'SIN' };
  assert.equal(japanZoneKey(itin(o), CITIES), '1-B', 'オープンジョーは往復2区間ではないので 1-B');
  const r = miles(o);
  const half7 = CHARTS.partner.roundtrip['1-B|7'].eco.after / 2;
  const half4 = CHARTS.partner.roundtrip['1-B|4'].eco.after / 2;
  assert.equal(r.miles, Math.round(half7) + Math.round(half4));
  assert.equal(r.breakdown.length, 2);
});

// =====================================================================
// 2. 必要マイル — ANA自社便チャート
// =====================================================================

test('ANA自社便はシーズンで必要マイルが変わる', () => {
  const o = { departure: 'HIJ', destination: 'CDG', outbound: ['HND', null, null] };
  const reg  = miles(o, { awardType: 'ana', season: 'regular' }).miles;
  const low  = miles(o, { awardType: 'ana', season: 'low' }).miles;
  const high = miles(o, { awardType: 'ana', season: 'high' }).miles;
  assert.equal(reg, 55000);
  assert.equal(low, 45000);
  assert.equal(high, 78000);
  assert.ok(low < reg && reg < high);
});

test('ANA自社便のチャートに無いゾーンは推定せず理由を返す', () => {
  const r = miles({ departure: 'HND', destination: 'CMN' }, { awardType: 'ana' });  // Zone 8
  assert.equal(r.miles, null);
  assert.match(r.reason, /Zone 8/);
});

test('提携チャートは Zone 8（アフリカ）を持っている', () => {
  const r = miles({ departure: 'HND', destination: 'CMN', outbound: ['FRA', null, null] });
  assert.equal(typeof r.miles, 'number');
  assert.equal(r.miles, CHARTS.partner.roundtrip['1-B|8'].eco.after);
});

test('海外発は対象外として返す（0マイルにしない）', () => {
  const r = miles({ departure: 'CDG', destination: 'HND' });
  assert.equal(r.miles, null);
  assert.match(r.reason, /日本発/);
});

test('未知のクラス・シーズンは例外にする', () => {
  assert.throws(() => miles({ departure: 'HND', destination: 'CDG' }, { cabin: 'suite' }), /未知のクラス/);
  assert.throws(() => miles({ departure: 'HND', destination: 'CDG' }, { season: 'sale' }), /未知のシーズン/);
});

// =====================================================================
// 3. 路線グラフ
// =====================================================================

test('特典で乗れない航空会社しか飛ばない区間は落とす', () => {
  assert.ok(graph.stats.kept > 500, `残った区間 ${graph.stats.kept}`);
  assert.ok(graph.stats.dropped > graph.stats.kept * 10, '大半の区間は対象外のはず');
  // JL(日本航空)だけが飛ぶ区間は特典では使えない
  const jlOnly = Object.entries(ROUTES).find(([k, v]) =>
    !k.startsWith('_') && v.length === 1 && v[0] === 'JL');
  if (jlOnly) {
    const [from, to] = jlOnly[0].split('-');
    assert.equal(graph.adj.get(from)?.has(to) ?? false, false);
  }
});

// =====================================================================
// 6. 特典の種類ごとに乗れる航空会社が違う（ANA自社便 と 提携 の使い分け）
// =====================================================================

test('ANA自社便の提案に、ANAが飛ばない区間が1つも混ざらない', () => {
  // 2026-09-06 の欠陥：運航会社を絞っておらず、羽田→グアム（UAのみ運航）を
  // ANA自社便の提案として出していた（28本中4本）
  const dests = CITIES.filter((c) => c.type === 'overseas').map((c) => c.iata);
  let checked = 0;
  for (const d of dests) {
    const { proposals } = propose({ origin: 'HND', destination: d, awardType: 'ana', ...NO_OJ }, ctxGeo);
    for (const p of proposals) {
      checked++;
      const legs = [['HND', ...p.itinerary.outbound.filter(Boolean), d],
                    [d, ...p.itinerary.return.filter(Boolean), 'HND']];
      for (const leg of legs) {
        for (let i = 0; i < leg.length - 1; i++) {
          const air = ROUTES[`${leg[i]}-${leg[i + 1]}`] ?? [];
          assert.ok(air.includes('NH'),
            `ANA自社便なのに ${leg[i]}-${leg[i + 1]} を使っている（運航 ${air.join(',')}）`);
        }
      }
    }
  }
  assert.ok(checked > 10, `検査した提案が少なすぎる（${checked}本）`);
});

test('ANAが飛んでいない行き先は、自社便モードでは0本になる', () => {
  const ana = propose({ origin: 'HND', destination: 'GUM', awardType: 'ana', ...NO_OJ }, ctxGeo);
  assert.equal(ana.proposals.length, 0, '羽田→グアムはUA運航のみ');
  const partner = propose({ origin: 'HND', destination: 'GUM', ...NO_OJ }, ctxGeo);
  assert.ok(partner.proposals.length > 0, '提携特典なら成立する');
});

test('提携特典では、スターアライアンス以外のANA提携社の区間も使える', () => {
  const set = allowedCarriers('partner', AIRLINES);
  assert.ok(set.size > AIRLINES.star_alliance.length, 'スタアラだけになっていない');
  AIRLINES.ana_partners.forEach((a) => assert.ok(set.has(a), `${a} が漏れている`));
  assert.deepEqual([...allowedCarriers('ana', AIRLINES)], ['NH']);
});

// =====================================================================
// 4. 提案の中身
// =====================================================================

test('復路の候補が1通りに縮まない（枝刈りの基準は旅程の目的地）', () => {
  // 復路の終点（日本・Zone1）を基準に枝刈りすると、海外の経由地が
  // すべて落ちて復路が「国内で乗り継ぐだけ」の1通りになる。
  // 2026-09-06 に実際にこの欠陥を出した
  const { stats } = propose({ origin: 'HIJ', destination: 'CDG', maxTransits: 2, ...NO_OJ }, ctx);
  assert.ok(stats.retPaths > 1, `復路の候補が ${stats.retPaths} 通りしかない`);
  assert.ok(stats.outPaths > 1);
});

test('広島→パリで提案が5本以上出る（完了の定義）', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2, ...NO_OJ }, ctx);
  assert.ok(proposals.length >= 5, `提案 ${proposals.length} 本`);
});

test('出力された提案は全件が規約判定に合格している（提案側で判定を作らない）', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2, ...NO_OJ }, ctx);
  for (const p of proposals) {
    const res = validateItinerary(p.itinerary, { awardType: 'partner', rules, cities: CITIES });
    assert.equal(res.ok, true, `不合格が混ざっている: ${p.route.join(' / ')}`);
  }
});

test('必要マイルの少ない順に並ぶ（不明は末尾）', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2, ...NO_OJ }, ctx);
  const known = proposals.filter((p) => p.miles != null).map((p) => p.miles);
  assert.deepEqual(known, [...known].sort((a, b) => a - b));
  const firstUnknown = proposals.findIndex((p) => p.miles == null);
  if (firstUnknown >= 0) {
    assert.ok(proposals.slice(firstUnknown).every((p) => p.miles == null));
  }
});

test('目的地より必要マイルの高いゾーンは経由地に現れない（第1条・第4条）', () => {
  const { proposals } = propose({ origin: 'HND', destination: 'BKK', wantStopover: true, maxTransits: 2, ...NO_OJ }, ctx);
  const destRank = ZONE_RANK[CITIES.find((c) => c.iata === 'BKK').zone];
  for (const p of proposals) {
    for (const iata of [...p.itinerary.outbound, ...p.itinerary.return].filter(Boolean)) {
      const c = CITIES.find((x) => x.iata === iata);
      if (c.type === 'overseas') {
        assert.ok((ZONE_RANK[c.zone] ?? 0) <= destRank, `${c.name}（Zone${c.zone}）が経由地に出ている`);
      }
    }
  }
});

test('ANA自社便モードでは海外の経由地が1つも出ない', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', awardType: 'ana', wantStopover: true, ...NO_OJ }, ctx);
  assert.ok(proposals.length >= 1);
  for (const p of proposals) {
    const ovs = [...p.itinerary.outbound, ...p.itinerary.return].filter(Boolean)
      .filter((i) => CITIES.find((c) => c.iata === i)?.type === 'overseas');
    assert.deepEqual(ovs, [], `ANAモードで海外経由 ${ovs} が出ている`);
    assert.equal(p.stopover, null, 'ANAモードは日本発の途中降機ができない');
  }
});

test('寄り道は1旅程に1つまで', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2, ...NO_OJ }, ctx);
  for (const p of proposals) {
    const n = [...p.itinerary.outboundSO, ...p.itinerary.returnSO].filter(Boolean).length;
    assert.ok(n <= 1, `途中降機が ${n} 箇所ある`);
  }
});

test('同じ（必要マイル・増える都市）の案は1本にまとめ、まとめた数を残す', () => {
  const { proposals, stats } = propose(
    { origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2, ...NO_OJ }, ctx);
  const keys = proposals.map((p) => `${p.miles}|${p.extraCity ?? '-'}`);
  assert.equal(new Set(keys).size, keys.length, '同じ組み合わせが2本出ている');
  // 規約は通ったが「ANA便でしか飛べない＋日本発の途中降機」で発券できない案は
  // 畳む前に落としている。その数は stats に残す（無言で捨てない）
  assert.equal(proposals.reduce((a, p) => a + p.variants, 0), stats.passed - stats.droppedAnaOnly,
    'まとめた本数の合計が、合格した組み合わせの数と合わない');
  assert.ok(proposals.length < stats.passed, '畳めていない');
});

test('寄り道を求めなければ寄り道つきの案は作らない', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', maxTransits: 2, ...NO_OJ }, ctx);
  assert.ok(proposals.every((p) => p.stopover === null));
});

// =====================================================================
// 5. 遠回り（しんどさ）の測定と、代表経路の選抜
// =====================================================================

test('必要マイルが同じなら遠回りの少ない順に並ぶ', () => {
  const { proposals } = propose({ origin: 'HND', destination: 'CDG', wantStopover: true, ...NO_OJ }, ctxGeo);
  const g = proposals.filter((p) => p.miles === 62000).map((p) => p.detourKm);
  assert.ok(g.length > 5);
  assert.deepEqual(g, [...g].sort((a, b) => a - b));
});

test('明らかな大回りは下位に落ちる（シドニー経由がフランクフルトより上に来ない）', () => {
  const { proposals } = propose({ origin: 'HND', destination: 'CDG', wantStopover: true, ...NO_OJ }, ctxGeo);
  const idx = (name) => proposals.findIndex((p) => p.stopoverName === name);
  const fra = idx('フランクフルト'), syd = idx('シドニー');
  assert.ok(fra >= 0 && syd >= 0, 'どちらの案も出ていること');
  assert.ok(fra < syd, `フランクフルト(${fra}) がシドニー(${syd}) より上にあること`);
  assert.equal(proposals[fra].effort, 'ほぼ通り道');
  assert.equal(proposals[syd].effort, '大回り');
});

test('代表経路の選抜で寄り道先の顔ぶれが減らない（黙って痩せないこと）', () => {
  // 都市ごとに最短の1本だけ残す高速化を入れた。速くなっても
  // 「行ける寄り道先」が減っていたら、それは静かな機能欠落になる
  const req = { origin: 'HND', destination: 'CDG', wantStopover: true, ...NO_OJ };
  const before = propose(req, ctx);      // 選抜なし（座標を渡さない）
  const after  = propose(req, ctxGeo);   // 選抜あり
  // 空港ではなく街の単位で比べる（代表に選ばれる空港は入れ替わりうる）
  const set = (r) => new Set(r.proposals.map((p) => p.extraCity ? cityKey(p.extraCity) : '-'));
  assert.deepEqual([...set(after)].sort(), [...set(before)].sort());
});

test('選抜した経路の本数を stats に残す（絞った事実を隠さない）', () => {
  const { stats } = propose({ origin: 'HND', destination: 'CDG', ...NO_OJ }, ctxGeo);
  assert.ok(stats.outPathsFound > stats.outPaths, '絞る前と後の両方が記録されていること');
  assert.ok(stats.retPathsFound > stats.retPaths);
});

test('国内オープンジョー（帰着地を変える）を提案できる', () => {
  // 「羽田発 → パリ → 羽田で寄り道 → 沖縄着」のような形
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', arrival: 'OKA', wantStopover: true }, ctxGeo);
  assert.ok(proposals.length > 0);
  for (const p of proposals) {
    assert.equal(p.itinerary.arrival, 'OKA');
    const res = validateItinerary(p.itinerary, { awardType: 'partner', rules, cities: CITIES });
    assert.equal(res.ok, true);
  }
});

// =====================================================================
// 7. 「増える都市」を1本の軸にする（寄り道と帰着地を掛け合わせない）
// =====================================================================

test('増える都市は1旅程に1つまで（寄り道と帰着地を掛け算しない）', () => {
  // 掛け合わせるとパリ行きだけで560本になり、選べる一覧でなくなる。
  // ★ただし「同じ都市への行き方」（帰着地／寄り道／自宅で途中降機）は別の旅なので、
  //   同じ都市が行き方の数だけ出る。畳むのは画面側（都市ごとに1行）
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  // ★航空会社のまとまり（plan）も別の旅。特典の種類を絞らずに呼ぶと、同じ都市・同じ行き方でも
  //   スターアライアンスの案と提携1社の案が別々に出る（2026-09-19 の「特典の種類」分割）
  const keys = proposals.map((p) => `${p.miles}|${p.extraCity ?? '-'}|${p.extraVia ?? '-'}|${p.homeLeg ?? '-'}|${p.plan}`);
  assert.equal(new Set(keys).size, keys.length, '同じ（増える都市・行き方・航空会社のまとまり）が2本出ている');
  assert.ok(proposals.length < 80, `一覧が長すぎる（${proposals.length}本）`);
  const cities = new Set(proposals.map((p) => p.extraCity ? cityKey(p.extraCity) : '-'));
  assert.ok(cities.size < 40, `都市が多すぎる（${cities.size}都市）`);
  for (const p of proposals) {
    const already = new Set(['HND', 'CDG'].map(cityKey));
    const extras = new Set([p.stopover, p.arrival, p.itinerary.departure]
      .filter(Boolean).map(cityKey).filter((x) => !already.has(x)));
    assert.ok(extras.size <= 1,
      `増える都市が ${extras.size} 都市ある: ${p.route.join(' / ')}`);
  }
});

test('帰着地を変える案は、就航路線の多い空港にしか降ろさない', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  const oj = proposals.filter((p) => p.openJaw);
  assert.ok(oj.length > 0, '帰着地を変える案が1本も出ていない');
  for (const p of oj) {
    assert.ok(hubScore(graph, p.arrival, allowedCarriers('partner', AIRLINES)) >= 8,
      `${p.arrivalName} は就航路線が少なすぎる`);
  }
});

test('遠回りの基準は「まっすぐ帰る旅程」（帰着地ごとに取り直さない）', () => {
  // 帰着地ごとに基準を取ると、どの帰着地の案も +0km になって並べられない
  const { proposals, stats } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  const home = proposals.filter((p) => !p.openJaw && p.detourKm != null);
  assert.equal(Math.min(...home.map((p) => p.detourKm)), 0, '基準となる0kmの案が無い');
  const zero = proposals.filter((p) => p.detourKm === 0);
  assert.ok(zero.length < 5, `+0km の案が多すぎる（${zero.length}本）＝基準が取り直されている`);
  assert.equal(stats.baseKm, Math.min(...home.map((p) => p.km)));
});

// =====================================================================
// 8. 1つの旅程の中で組み合わせてよい航空会社（2026-09-07 一次情報から是正）
// =====================================================================
// 公式原文：
//  「スターアライアンス加盟航空会社運航便とスター アライアンス コネクティング
//    パートナーであれば、各航空会社を自由に組み合わせた旅程もご利用になれます。」
//  「単一の提携航空会社運航便での旅程のみご利用になれます。」（非加盟の提携社）
// =====================================================================

test('提携社を「1社だけの旅程」として扱う計画が立つ', () => {
  const plans = carrierPlans('partner', AIRLINES);
  assert.equal(plans[0].id, 'star');
  const singles = plans.filter((p) => p.id.startsWith('single:'));
  assert.ok(singles.length > 0, '単一提携社の計画が1つも無い');
  singles.forEach((p) => assert.equal(p.carriers.size, 1, '単一社の計画に2社以上入っている'));
  assert.deepEqual(carrierPlans('ana', AIRLINES).map((p) => p.id), ['ana']);
});

test('提案は「スタアラ全体」か「提携社1社」のどちらかで全区間を通せる', () => {
  // 2026-09-06 の欠陥：両者を混ぜたグラフで探索し、スタアラ便とベトナム航空便を
  // 同じ旅程に入れた提案を114本出していた
  const SA = new Set(AIRLINES.star_alliance);
  const singles = AIRLINES.ana_partners.filter((a) => !SA.has(a));
  let checked = 0;
  for (const d of ['CDG', 'BKK', 'SYD', 'SIN', 'HNL']) {
    const { proposals } = propose({ origin: 'HND', destination: d, wantStopover: true }, ctxGeo);
    for (const p of proposals) {
      checked++;
      const segs = [];
      // ★切符の出発地は自宅とは限らない（往路側の自宅途中降機では国内の別都市になる）
      for (const leg of [[p.itinerary.departure, ...p.itinerary.outbound.filter(Boolean), d],
                         [d, ...p.itinerary.return.filter(Boolean), p.arrival]]) {
        for (let i = 0; i < leg.length - 1; i++) segs.push(ROUTES[`${leg[i]}-${leg[i + 1]}`] ?? []);
      }
      const okSA = segs.every((a) => a.some((x) => SA.has(x)));
      const okOne = singles.some((c) => segs.every((a) => a.includes(c)));
      assert.ok(okSA || okOne,
        `どの社のまとまりでも通せない旅程: ${p.route.join(' / ')}`);
    }
  }
  assert.ok(checked > 50, `検査した提案が少なすぎる（${checked}本）`);
});

test('日本国内線の乗り継ぎは ANA 運航便のみ（2026-05-19 搭乗分〜）', () => {
  const dom = new Set(CITIES.filter((c) => c.type === 'domestic').map((c) => c.iata));
  let checked = 0;
  for (const [o, d] of [['HIJ', 'CDG'], ['HND', 'SIN'], ['HIJ', 'HNL']]) {
    const { proposals } = propose({ origin: o, destination: d, wantStopover: true }, ctxGeo);
    for (const p of proposals) {
      for (const leg of [[p.itinerary.departure, ...p.itinerary.outbound.filter(Boolean), d],
                         [d, ...p.itinerary.return.filter(Boolean), p.arrival]]) {
        for (let i = 0; i < leg.length - 1; i++) {
          if (!dom.has(leg[i]) || !dom.has(leg[i + 1])) continue;
          checked++;
          const air = ROUTES[`${leg[i]}-${leg[i + 1]}`] ?? [];
          assert.ok(air.includes('NH'),
            `国内区間 ${leg[i]}-${leg[i + 1]} が ANA 運航でない（運航 ${air.join(',')}）`);
        }
      }
    }
  }
  assert.ok(checked > 0, '国内区間を含む提案が1本も無い＝検査になっていない');
});

test('同じ街の別空港は「もう1都市」に数えない（羽田と成田・関空と伊丹）', () => {
  // 羽田発の旅程で成田に降りても、増えるのは都市ではなく空港でしかない
  for (const o of ['HND', 'KIX']) {
    const { proposals } = propose({ origin: o, destination: 'CDG', wantStopover: true }, ctxGeo);
    const keys = proposals.map((p) => `${p.miles}|${p.extraCity ? cityKey(p.extraCity) : '-'}|${p.extraVia ?? '-'}|${p.homeLeg ?? '-'}|${p.plan}`);
    assert.equal(new Set(keys).size, keys.length, `${o}発で同じ街・同じ行き方・同じ航空会社のまとまりが2行出ている`);
    for (const p of proposals) {
      if (!p.extraCity) continue;
      assert.notEqual(cityKey(p.extraCity), cityKey(o), `出発地と同じ街（${p.extraCityName}）を増える都市にしている`);
      assert.notEqual(cityKey(p.extraCity), 'CDG', '目的地を増える都市にしている');
    }
  }
});

// =====================================================================
// 9. 旅程が「どの特典・どの航空会社のまとまりで飛べるか」を出す
// =====================================================================

test('提案には、どの特典・どの航空会社のまとまりかが付く', () => {
  const { proposals } = propose({ origin: 'HND', destination: 'HAN', wantStopover: true }, ctxGeo);
  assert.ok(proposals.length > 0);
  for (const p of proposals) {
    assert.ok(p.plan, 'plan が無い');
    assert.ok(p.planLabel && p.planLabel.length > 0, 'planLabel が無い');
    // 区間ごとに、その旅程で実際に乗れる社が1社以上いること
    assert.ok(p.carriersByLeg.length > 0);
    for (const l of p.carriersByLeg) {
      assert.ok(l.airlines.length > 0, `${l.from}→${l.to} に乗れる社がいない`);
    }
  }
  // 羽田→ハノイの直行は VN の単独運航なので「1社のみ」の旅程になる
  const direct = proposals.find((p) => p.transits === 0) ?? proposals[0];
  assert.ok(direct.planLabel.includes('スターアライアンス') || direct.plan.startsWith('single:'));
});

test('同じ旅程を3つの特典すべてで判定する', () => {
  const it = {
    departure: 'HND', destination: 'CDG', arrival: null, returnDep: null,
    outbound: ['FRA', null, null], return: ['ICN', null, null],
    outboundSO: [false, false, false], returnSO: [true, false, false],
    outboundSurfaceAfter: [false, false, false], returnSurfaceAfter: [false, false, false],
  };
  const kinds = evaluateByKind(it, ctxGeo);
  assert.deepEqual(kinds.map((k) => k.kind), ['ana', 'star', 'partner']);
  const by = Object.fromEntries(kinds.map((k) => [k.kind, k]));
  // 日本発の途中降機があるので ANA自社便では成立しない
  assert.equal(by.ana.ok, false);
  assert.ok(by.ana.reasons.some((r) => r.includes('途中降機')));
  // スタアラなら成立する
  assert.equal(by.star.ok, true, by.star.reasons.join(' / '));
  // 4区間を1社で飛べる提携社はいない
  assert.equal(by.partner.ok, false);
});

test('ANAが飛ばない直行便は、提携社1社の旅程としてだけ成立する', () => {
  const it = {
    departure: 'HND', destination: 'HAN', arrival: null, returnDep: null,
    outbound: [null, null, null], return: [null, null, null],
    outboundSO: [false, false, false], returnSO: [false, false, false],
    outboundSurfaceAfter: [false, false, false], returnSurfaceAfter: [false, false, false],
  };
  const by = Object.fromEntries(evaluateByKind(it, ctxGeo).map((k) => [k.kind, k]));
  assert.equal(by.ana.ok, false, '羽田→ハノイをANAは飛んでいない');
  assert.equal(by.star.ok, false, 'スターアライアンス加盟社も飛んでいない');
  assert.equal(by.partner.ok, true);
  assert.deepEqual(by.partner.airlines.map((a) => a.code), ['VN']);
});

test('提携社は1社ずつ別の計画として扱われ、名前が引ける', () => {
  const plans = carrierPlans('partner', AIRLINES);
  const vn = plans.find((p) => p.id === 'single:VN');
  assert.ok(vn, 'ベトナム航空の単独計画が無い');
  assert.match(planLabel('single:VN', AIRLINES), /ベトナム航空/);
  assert.match(planLabel('ana', AIRLINES), /ANA運航便のみ/);
});

test('スターアライアンス加盟社の一覧が一次情報から取れている', () => {
  assert.equal(AIRLINES._meta.verified_star_alliance, true, '未突合のまま使っている');
  assert.ok(AIRLINES.star_alliance.length >= 25,
    `加盟社が ${AIRLINES.star_alliance.length} 社しかない`);
  ['NH', 'UA', 'LH', 'SQ', 'TG', 'AZ'].forEach((c) =>
    assert.ok(AIRLINES.star_alliance.includes(c), `${c} が漏れている`));
  // ベトナム航空は加盟社ではなく提携社（単一社旅程のみ）
  assert.ok(!AIRLINES.star_alliance.includes('VN'));
  assert.ok(AIRLINES.ana_partners.includes('VN'));
  // 次回見直しの期限が入っていること（半期に1回）
  assert.match(AIRLINES._meta.next_review, /^\d{4}-\d{2}-\d{2}$/);
});

// =====================================================================
// 自宅で途中降機して、国内線1区間を別の日に飛ぶ（2026-09-07 追加）
// =====================================================================
// ユーザーの指摘で分かった取りこぼし。規約判定は最初から通っていたのに、
// 同じ都市の中から「飛行距離が最短の1本」だけを代表にしていたため、
// 遠回りになる自宅経由が毎回消えていた（羽田→パリで 2,752 通りが埋没）。
// 途中降機は往路・復路のどちらに置いてもよい（ANA公式・現行版で確認）。

test('自宅で途中降機して国内線をあとに残す案が出る（復路版）', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  const home = proposals.filter((p) => p.extraVia === 'home');
  assert.ok(home.length >= 3, `自宅で途中降機する案が少なすぎる（${home.length}本）`);

  const ret = home.filter((p) => {
    const rp = p.itinerary.return.filter(Boolean);
    return rp.length && rp[rp.length - 1] === 'HND';
  });
  assert.ok(ret.length >= 1, '復路版（パリ→羽田［途中降機］→国内）が1本も無い');

  const oka = ret.find((p) => p.arrival === 'OKA');
  assert.ok(oka, '＋那覇の復路版が出ていない');
  assert.equal(oka.miles, 62000, '寄り道なしの案と同じ追加マイルで済むはず');
  assert.equal(oka.itinerary.returnSO[oka.itinerary.return.filter(Boolean).length - 1], true,
    '自宅の滞在が途中降機として立っていない');
});

test('自宅で途中降機して国内線を先に飛ぶ案も出る（往路版）', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  const out = proposals.filter((p) => {
    const op = p.itinerary.outbound.filter(Boolean);
    return p.extraVia === 'home' && op.length && op[0] === 'HND' && p.itinerary.outboundSO[0];
  });
  assert.ok(out.length >= 1, '往路版（国内→羽田［途中降機］→パリ）が1本も無い');
  for (const p of out) {
    assert.notEqual(p.itinerary.departure, 'HND', '切符の出発地が自宅のままになっている');
    assert.equal(p.extraCity, p.itinerary.departure, '増える都市は切符の出発地のはず');
  }
});

test('ANA自社便では自宅で途中降機できない（日本発の途中降機は不可）', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', awardType: 'ana', wantStopover: true }, ctxGeo);
  const home = proposals.filter((p) => p.extraVia === 'home');
  assert.equal(home.length, 0,
    `ANA自社便に自宅での途中降機が ${home.length} 本出ている（規約違反）`);
});

test('国内線が羽田経由しかない出発地では、自宅での途中降機は出ない（広島）', () => {
  // 復路の日本国内の乗り換えは1回まで。自宅での途中降機がその1回を使うため、
  // パリ→羽田→広島→那覇（国内2回）は組めない。黙って0本にせず、
  // 「この出発地では選べない」と言えるように 0 であることを固定する
  const { proposals } = propose(
    { origin: 'HIJ', destination: 'CDG', wantStopover: true }, ctxGeo);
  assert.equal(proposals.filter((p) => p.extraVia === 'home').length, 0);
});

test('自宅で降りても次が最終区間でなければ「自宅で途中降機」に数えない', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  for (const p of proposals.filter((x) => x.extraVia === 'home')) {
    const op = p.itinerary.outbound.filter(Boolean);
    const rp = p.itinerary.return.filter(Boolean);
    const retOk = rp.length && rp[rp.length - 1] === 'HND' && p.itinerary.returnSO[rp.length - 1];
    const outOk = op.length && op[0] === 'HND' && p.itinerary.outboundSO[0];
    assert.ok(retOk || outOk,
      `切り離せる国内線1区間になっていない: ${p.route.join(' / ')}`);
  }
});

test('画面に出す形は都市ごとに1行で、行き方は行の中に入る', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  const rows = groupByCity(proposals, { airports: COORDS });   // airports.json は座標と国を同じ表に持つ

  assert.ok(rows.length < proposals.length, '畳めていない');
  // 都市 × 航空会社のまとまりで1行。同じ都市でも、スタアラで行く案とベトナム航空で行く案は
  //   別の行にする（畳むと、どの社の案なのかが画面から消える）
  const names = rows.map((r) => `${r.iata}|${r.plan}`);
  assert.equal(new Set(names).size, names.length, '同じ都市・同じ航空会社のまとまりが2行ある');

  // ドイツはフランクフルトとミュンヘンが1行にまとまる（Q10・2026-09-07）
  const de = rows.find((r) => r.country === 'DE');
  assert.ok(de, 'ドイツの行が無い');
  assert.ok(de.sameCountry.length >= 1, `同じ国の残りが畳まれていない: ${de.city}`);

  // 国内は畳まない（福岡と那覇が同じ行にならない）
  const jp = rows.filter((r) => r.country === 'JP').map((r) => r.city);
  assert.ok(jp.includes('福岡') && jp.includes('那覇'), `国内が畳まれている: ${jp.join(',')}`);

  // 那覇の行には3通り（帰りに降りる・寄り道・自宅で途中降機）が入る
  const oka = rows.find((r) => r.iata === 'OKA');
  const kinds = new Set(oka.ways.map((w) => w.extraVia));
  assert.ok(kinds.has('home'), '那覇の行に自宅で途中降機が無い');
  assert.ok(kinds.size >= 2, `那覇の行き方が ${kinds.size} 通りしかない`);
});

test('帰りの場所を自分で指定したら、その街は「もう1都市」に数えない', () => {
  // 指定した街は提案ではなく前提。1都市の枠を食わせると、
  // 「福岡発 → リスボン → 羽田着」で寄り道が1本も出せなくなる（2026-09-08 是正）
  const req = { origin: 'FUK', destination: 'LIS', wantStopover: true };
  const pinned = propose({ ...req, arrival: 'HND' }, ctxGeo);
  assert.ok(pinned.proposals.length > 10,
    `帰着地を指定したら候補が ${pinned.proposals.length} 本しか出ない`);
  assert.ok(pinned.proposals.some((p) => p.extraCity == null),
    '「もう1都市なし」の基準になる旅程が無い');
  for (const p of pinned.proposals) {
    assert.notEqual(p.extraCity, 'HND', '指定した帰着地を「増える都市」に数えている');
    assert.equal(p.arrival, 'HND', '指定した帰着地が守られていない');
  }

  // 復路の出発地（海外オープンジョー）も同じ扱い
  const oj = propose({ ...req, returnDep: 'CDG' }, ctxGeo);
  assert.ok(oj.proposals.length > 10, '復路出発地を指定したら候補が出ない');
  for (const p of oj.proposals) {
    assert.notEqual(p.extraCity, 'CDG', '指定した復路の出発地を「増える都市」に数えている');
    assert.equal(p.itinerary.returnDep, 'CDG', '指定した復路の出発地が守られていない');
  }
});

// =====================================================================
// 実際に選べる便が1社だけの旅程（2026-09-08 追加）
// =====================================================================
// 提案は「区間ごとに、その特典で乗れる社が1社以上いる」ことしか見ていない。
// 全区間で選べるのがANAだけなら、実際に予約できるのはANA運航便だけの旅程で、
// ANA国際線特典の規約（日本発の途中降機は不可）が当たる可能性がある。
// 公式は提携特典の対象便に ANA(NH) を含めるが、ANA便だけの旅程を提携特典として
// 発券できるかは沈黙している。沈黙している以上「成立する」と言い切らない。

test('全区間で選べる社が1社だけかを判定できる', () => {
  assert.equal(soleCarrierOf([{ airlines: ['NH'] }, { airlines: ['NH'] }]), 'NH');
  assert.equal(soleCarrierOf([{ airlines: ['NH'] }, { airlines: ['NH', 'LH'] }]), null);
  assert.equal(soleCarrierOf([{ airlines: ['NH'] }, { airlines: ['LH'] }]), null);
  assert.equal(soleCarrierOf([]), null);
});

test('ANA便しか選べない旅程で日本発の途中降機を組んだら「要確認」を付ける', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'CDG', wantStopover: true }, ctxGeo);
  const sole = proposals.filter((p) => soleCarrierOf(p.carriersByLeg) === 'NH');
  assert.ok(sole.length > 0, 'ANAしか選べない旅程が1本も出ていない（前提が崩れた）');

  for (const p of sole) {
    const hasSO = p.stopover != null;
    if (hasSO) {
      assert.ok(p.needsCheck, `ANA便だけの途中降機つき旅程に注意書きが無い: ${p.route.join(' / ')}`);
      assert.ok(p.warnings.some((w) => w.includes('ANA')), '警告文に入っていない');
    } else {
      assert.equal(p.needsCheck, undefined, '途中降機の無い旅程にまで注意書きを付けている');
    }
  }
  // 複数社から選べる旅程には付けない
  for (const p of proposals.filter((x) => soleCarrierOf(x.carriersByLeg) === null)) {
    assert.equal(p.needsCheck, undefined, `社を選べる旅程に注意書きが付いている: ${p.route.join(' / ')}`);
  }
});

test('ANA便しか選べない旅程は、スターアライアンス特典としては成立しない', () => {
  const it = {
    departure: 'HND', destination: 'CDG', arrival: 'FUK', returnDep: null,
    outbound: [null, null, null], return: ['HND', null, null],
    outboundSO: [false, false, false], returnSO: [true, false, false],
    outboundSurfaceAfter: [false, false, false], returnSurfaceAfter: [false, false, false],
  };
  const kinds = evaluateByKind(it, { rules, cities: CITIES, graph, airlines: AIRLINES });
  // スターアライアンス特典にするには、ANA以外の加盟社の便が1区間以上必要。
  // ANA便だけの旅程はANA国際線特典として扱われ、日本発の途中降機ができない
  const star = kinds.find((k) => k.kind === 'star');
  assert.equal(star.ok, false, 'ANA便だけの旅程をスタアラ特典として成立と出している');
  assert.equal(star.anaOnly, true, 'ANA便しか選べないことを示せていない');
  assert.ok(star.reasons.some((r) => r.includes('1区間以上')), star.reasons.join(' / '));

  const ana = kinds.find((k) => k.kind === 'ana');
  assert.equal(ana.ok, false, 'ANA自社便では日本発の途中降機ができない');
});

test('ANA便でしか飛べない途中降機つきの案は提案に出さない（落とした数を残す）', () => {
  for (const [o, d] of [['HND', 'CDG'], ['HND', 'HNL']]) {
    const { proposals, stats } = propose(
      { origin: o, destination: d, wantStopover: true }, ctxGeo);
    const bad = proposals.filter(
      (p) => p.stopover && soleCarrierOf(p.carriersByLeg) === 'NH');
    assert.equal(bad.length, 0,
      `${o}→${d} にANA便だけの途中降機つきが ${bad.length} 本残っている`);
    assert.ok(stats.droppedAnaOnly > 0,
      `${o}→${d} で落とした件数が記録されていない`);
  }
});

test('ANA便だけで組める案は「ANA国際線特典として扱う」と印を付け、マイルもANAのチャートで出す', () => {
  const { proposals } = propose(
    { origin: 'HND', destination: 'HNL', wantStopover: true }, ctxGeo);
  const ana = proposals.filter((p) => p.actualAward === 'ana');
  assert.ok(ana.length > 0, 'ANA便だけで組める案が1本も無い（前提が崩れた）');
  for (const p of ana) {
    assert.equal(soleCarrierOf(p.carriersByLeg), 'NH');
    assert.equal(p.stopover, null, '途中降機つきが残っている');
    assert.ok(p.awardNote.includes('ANA国際線特典'), p.awardNote);
    // ANAのチャートはシーズンで変わる。提携チャートの値を出したままにしない
    assert.ok(/シーズン/.test(p.milesNote ?? ''), `マイルの注記がANA側になっていない: ${p.milesNote}`);
  }
});
