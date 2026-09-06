// =====================================================================
// miles-core / proposer の単体テスト（node --test で実行）
//   cd projects/my8flyer && node --test tests/proposer.test.mjs
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { CITIES, STAR_ALLIANCE, CHARTS, buildRules, loadRoutes } from './_load.mjs';
import { requiredMiles, japanZoneKey } from '../src/miles-core.js';
import { buildGraph, propose } from '../src/proposer.js';
import { validateItinerary, ZONE_RANK } from '../src/rules-core.js';

const rules = buildRules();
const graph = buildGraph(loadRoutes(), CITIES, { carriers: STAR_ALLIANCE });
const ctx   = { rules, charts: CHARTS, cities: CITIES, graph };

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
  const routes = loadRoutes();
  const jlOnly = Object.entries(routes).find(([k, v]) =>
    !k.startsWith('_') && v.length === 1 && v[0] === 'JL');
  if (jlOnly) {
    const [from, to] = jlOnly[0].split('-');
    assert.equal(graph.adj.get(from)?.has(to) ?? false, false);
  }
});

// =====================================================================
// 4. 提案の中身
// =====================================================================

test('復路の候補が1通りに縮まない（枝刈りの基準は旅程の目的地）', () => {
  // 復路の終点（日本・Zone1）を基準に枝刈りすると、海外の経由地が
  // すべて落ちて復路が「国内で乗り継ぐだけ」の1通りになる。
  // 2026-09-06 に実際にこの欠陥を出した
  const { stats } = propose({ origin: 'HIJ', destination: 'CDG', maxTransits: 2 }, ctx);
  assert.ok(stats.retPaths > 1, `復路の候補が ${stats.retPaths} 通りしかない`);
  assert.ok(stats.outPaths > 1);
});

test('広島→パリで提案が5本以上出る（完了の定義）', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2 }, ctx);
  assert.ok(proposals.length >= 5, `提案 ${proposals.length} 本`);
});

test('出力された提案は全件が規約判定に合格している（提案側で判定を作らない）', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2 }, ctx);
  for (const p of proposals) {
    const res = validateItinerary(p.itinerary, { awardType: 'partner', rules, cities: CITIES });
    assert.equal(res.ok, true, `不合格が混ざっている: ${p.route.join(' / ')}`);
  }
});

test('必要マイルの少ない順に並ぶ（不明は末尾）', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2 }, ctx);
  const known = proposals.filter((p) => p.miles != null).map((p) => p.miles);
  assert.deepEqual(known, [...known].sort((a, b) => a - b));
  const firstUnknown = proposals.findIndex((p) => p.miles == null);
  if (firstUnknown >= 0) {
    assert.ok(proposals.slice(firstUnknown).every((p) => p.miles == null));
  }
});

test('目的地より必要マイルの高いゾーンは経由地に現れない（第1条・第4条）', () => {
  const { proposals } = propose({ origin: 'HND', destination: 'BKK', wantStopover: true, maxTransits: 2 }, ctx);
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
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', awardType: 'ana', wantStopover: true }, ctx);
  assert.ok(proposals.length >= 1);
  for (const p of proposals) {
    const ovs = [...p.itinerary.outbound, ...p.itinerary.return].filter(Boolean)
      .filter((i) => CITIES.find((c) => c.iata === i)?.type === 'overseas');
    assert.deepEqual(ovs, [], `ANAモードで海外経由 ${ovs} が出ている`);
    assert.equal(p.stopover, null, 'ANAモードは日本発の途中降機ができない');
  }
});

test('寄り道は1旅程に1つまで', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2 }, ctx);
  for (const p of proposals) {
    const n = [...p.itinerary.outboundSO, ...p.itinerary.returnSO].filter(Boolean).length;
    assert.ok(n <= 1, `途中降機が ${n} 箇所ある`);
  }
});

test('同じ（必要マイル・寄り道先）の案は1本にまとめ、まとめた数を残す', () => {
  const req = { origin: 'HIJ', destination: 'CDG', wantStopover: true, maxTransits: 2 };
  const merged = propose(req, ctx);
  const raw    = propose({ ...req, dedupe: 'none' }, ctx);
  assert.ok(merged.proposals.length < raw.proposals.length);
  const keys = merged.proposals.map((p) => `${p.miles}|${p.stopover ?? '-'}`);
  assert.equal(new Set(keys).size, keys.length, '同じ組み合わせが2本出ている');
  assert.equal(merged.proposals.reduce((a, p) => a + p.variants, 0), raw.proposals.length,
    'まとめた本数の合計が元の本数と合わない');
});

test('寄り道を求めなければ寄り道つきの案は作らない', () => {
  const { proposals } = propose({ origin: 'HIJ', destination: 'CDG', maxTransits: 2 }, ctx);
  assert.ok(proposals.every((p) => p.stopover === null));
});
