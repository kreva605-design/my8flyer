// =====================================================================
// rules-core の単体テスト（node --test で実行）
//   cd projects/my8flyer && node --test tests/
// =====================================================================
// 目的は2つ。
//  ① index.html の validate() から抽出したとき、判定が変わっていないこと（回帰）
//  ② 2026-09-06 に起こした規約の誤読（旧版を現行版と読んだ）を二度と通さないこと
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  buildAwardRules, selectEffectiveValues, validateItinerary, countTransitsFor,
} from '../src/rules-core.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

// 規約値の正本
const RULES_JSON = JSON.parse(readFileSync(join(ROOT, 'data/award-rules.json'), 'utf8'));

// 都市マスタは index.html の CITIES をそのまま読む。
// テスト用に写経すると、都市を足したときにテストだけ古いままになる。
function loadCities() {
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const m = html.match(/const CITIES = \[[\s\S]*?\n\];/);
  if (!m) throw new Error('index.html から CITIES を取り出せません');
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn CITIES;`)();
}
const CITIES = loadCities();

// 適用日を固定する。「今日」で走らせると、規約の改定日を跨いだ日に
// 理由の分からない失敗をする
const ASOF_NOW    = '2026-09-06';   // 現行版（2025-06-24以降）
const ASOF_LEGACY = '2025-01-01';   // 旧版（2025-06-23まで）

const rules = buildAwardRules(RULES_JSON, { asOf: ASOF_NOW });

// 旅程の組み立てヘルパ（未指定は現行UIの初期値と同じ）
function itin(o = {}) {
  return {
    departure: null, destination: null, arrival: null, returnDep: null,
    outbound: [null, null, null], return: [null, null, null],
    outboundSO: [false, false, false], returnSO: [false, false, false],
    outboundSurfaceAfter: [false, false, false], returnSurfaceAfter: [false, false, false],
    ...o,
  };
}
const run = (o, awardType = 'partner', r = rules) =>
  validateItinerary(itin(o), { awardType, rules: r, cities: CITIES });

const codes = (res, code) => res.checks.filter((c) => c.code === code);
const ng    = (res, code) => codes(res, code).some((c) => c.ok === false);

// =====================================================================
// 1. 規約値の読み込み（誤読の再発防止）
// =====================================================================

test('現行版の規約値を採る（旧版を拾わない）', () => {
  assert.equal(rules.partner.transitDomMax, 1, '提携・国内乗り換えは往路復路各1回');
  assert.equal(rules.partner.transitOvsMax, 2, '提携・海外乗り換えは往路復路各2回');
  assert.equal(rules.partner.stopoverMax, 1, '提携・途中降機は旅程全体で1回');
  assert.equal(rules.partner.stopoverJapanAllowed, true);
  assert.equal(rules.ana.transitDomMax, 1, 'ANA自社便・国内乗り換えは各1回');
  assert.equal(rules.ana.transitOvsMax, 0, 'ANA自社便・海外乗り換えの規定なし＝不可');
  assert.equal(rules.ana.stopoverJapanAllowed, false, 'ANA自社便は日本発の途中降機不可');
});

test('採用した規約値がどの版か追える', () => {
  assert.match(rules._sources['partner.roundtrip.transit.domestic'], /@2025-06-24$/);
  assert.match(rules._sources['ana.roundtrip.transit.domestic'], /@2025-06-24$/);
});

test('2025-06-23 以前を指定したときだけ旧版（各2回）が選ばれる', () => {
  const legacy = selectEffectiveValues(RULES_JSON, ASOF_LEGACY);
  assert.equal(legacy['partner.roundtrip.transit.domestic'].value, 2);
  assert.equal(legacy['ana.roundtrip.transit.domestic'].value, 2);
  assert.match(legacy['partner.roundtrip.transit.domestic']._key, /@legacy$/);
});

test('旧版しか無い日付では cfg を組まずに止まる（旧版で判定させない）', () => {
  // 2025-01-01 時点の値は国内乗り換えの2件しか採取していない。
  // 足りないまま「提携の海外乗り換えは2回」等を現行値で埋めると、
  // 新旧が混ざった cfg で判定してしまう
  assert.throws(() => buildAwardRules(RULES_JSON, { asOf: ASOF_LEGACY }), /規約値が見つかりません/);
});

test('規約値が欠けていたら例外にする（不明な上限で「問題なし」を出さない）', () => {
  const broken = JSON.parse(JSON.stringify(RULES_JSON));
  delete broken.values['ana.roundtrip.transit.overseas@2025-06-24'];
  assert.throws(() => buildAwardRules(broken, { asOf: ASOF_NOW }), /ana\.roundtrip\.transit\.overseas/);
});

// =====================================================================
// 2. 乗り換え回数（今回の誤りの再発防止）
// =====================================================================

test('国内乗り換え2回は不合格', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG', outbound: ['ITM', 'HND', null] });
  assert.equal(res.ok, false);
  assert.ok(ng(res, 'transit.out.dom'), '往路の国内乗り換え超過が出ること');
  assert.match(codes(res, 'transit.out.dom')[0].msg, /2\/1/);
});

test('国内乗り換え1回は合格', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG', outbound: ['HND', null, null] });
  assert.equal(res.hasNg, false, res.checks.filter((c) => c.ok === false).map((c) => c.msg).join(' / '));
});

test('復路の国内乗り換え2回も不合格（往路だけ見ていない）', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG', return: ['HND', 'ITM', null] });
  assert.ok(ng(res, 'transit.ret.dom'));
});

test('海外乗り換えは提携なら2回まで・3回で不合格', () => {
  const ok2 = run({ departure: 'HND', destination: 'CDG', outbound: ['ICN', 'PVG', null] });
  assert.equal(ok2.checks.some((c) => c.code === 'transit.out.ovs'), false);
  const ng3 = run({ departure: 'HND', destination: 'CDG', outbound: ['ICN', 'PVG', 'TPE'] });
  assert.ok(ng(ng3, 'transit.out.ovs'));
});

test('ANA自社便モードでは海外乗り換えが1回でも不合格', () => {
  const res = run({ departure: 'HND', destination: 'CDG', outbound: ['ICN', null, null] }, 'ana');
  assert.ok(ng(res, 'transit.out.ovs'));
  assert.match(codes(res, 'transit.out.ovs')[0].msg, /日本以外の乗り換えはできません/);
});

test('目的地は乗り換え回数に含まれない', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG' });
  const cnt = countTransitsFor(itin({ departure: 'HIJ', destination: 'CDG' }), { rules, cities: CITIES });
  assert.deepEqual(cnt.out, { dom: 0, ovs: 0 });
  assert.equal(res.hasNg, false);
});

// =====================================================================
// 3. 途中降機（未実装だった2条文のうち1つ）
// =====================================================================

test('途中降機は乗り換え回数に含まれる（国内SO＋国内乗継で超過）', () => {
  const res = run({
    departure: 'HIJ', destination: 'CDG',
    outbound: ['HND', 'ITM', null], outboundSO: [true, false, false],
  });
  assert.ok(ng(res, 'transit.out.dom'), '途中降機の地点も1回として数えること');
});

test('途中降機は旅程全体で1回まで（2回で不合格）', () => {
  const res = run({
    departure: 'HIJ', destination: 'CDG',
    outbound: ['HND', null, null], outboundSO: [true, false, false],
    return: ['ICN', null, null],   returnSO: [true, false, false],
  });
  assert.ok(ng(res, 'stopover.count'));
  assert.match(codes(res, 'stopover.count')[0].msg, /現在2箇所/);
});

test('ANA自社便モードは日本発の途中降機ができない', () => {
  const res = run({
    departure: 'HIJ', destination: 'CDG',
    outbound: ['HND', null, null], outboundSO: [true, false, false],
  }, 'ana');
  assert.ok(ng(res, 'stopover.japan'));
});

test('提携モードなら日本発でも途中降機1回は合格', () => {
  const res = run({
    departure: 'HIJ', destination: 'CDG',
    outbound: ['HND', null, null], outboundSO: [true, false, false],
  });
  assert.equal(res.hasNg, false, res.checks.filter((c) => c.ok === false).map((c) => c.msg).join(' / '));
});

// =====================================================================
// 4. 地上移動区間（未実装だった2条文のもう1つ）
// =====================================================================

test('地上移動でつないだ2地点は乗り換え1回（羽田着→成田発）', () => {
  const base = {
    departure: 'HIJ', destination: 'CDG',
    outbound: ['HND', 'NRT', null],
  };
  const withoutSurface = run(base);
  assert.ok(ng(withoutSurface, 'transit.out.dom'), '地上移動でなければ2回で超過');

  const withSurface = run({ ...base, outboundSurfaceAfter: [true, false, false] });
  assert.equal(withSurface.hasNg, false, withSurface.checks.filter((c) => c.ok === false).map((c) => c.msg).join(' / '));
});

test('地上移動区間は「同じ区間を2回飛ぶ」判定に数えない', () => {
  // 往路 HND→NRT を地上移動、復路も NRT→HND を地上移動にした場合、
  // 飛行区間としては重複していない
  const res = run({
    departure: 'HIJ', destination: 'CDG', arrival: 'HIJ',
    outbound: ['HND', 'NRT', null], outboundSurfaceAfter: [true, false, false],
    return:   ['NRT', 'HND', null], returnSurfaceAfter:   [true, false, false],
  });
  const dup = codes(res, 'unofficial.dup_segment');
  assert.equal(dup.length, 0, dup[0]?.msg ?? '');
});

// =====================================================================
// 5. 第1〜7条（抽出前の validate() と同じ判定になること）
// =====================================================================

test('[第1条] 目的地より高いゾーンの経由地は不合格', () => {
  const res = run({ departure: 'HND', destination: 'HNL', outbound: ['CDG', null, null] });
  assert.ok(ng(res, 'rule1'));
});

test('[第1条] 国内のみの旅程は対象外', () => {
  const res = run({ departure: 'HIJ', destination: 'OKA' });
  assert.ok(ng(res, 'rule1'));
});

test('[第2条] 経由地が出発地・目的地と同じなら不合格', () => {
  const res = run({ departure: 'HND', destination: 'CDG', outbound: ['HND', null, null] });
  assert.ok(ng(res, 'rule2.out'));
});

test('[第3条] エリア3発→エリア1着でエリア2を経由すると不合格（提携のみ）', () => {
  const res = run({ departure: 'HND', destination: 'LAX', outbound: ['FRA', null, null] });
  assert.ok(ng(res, 'rule3'));
  // ANA自社便モードでは第3条を適用しない（別の理由＝海外乗換不可で落ちる）
  const anaRes = run({ departure: 'HND', destination: 'LAX', outbound: ['FRA', null, null] }, 'ana');
  assert.equal(codes(anaRes, 'rule3').length, 0);
});

test('[第4条] 目的地より高いゾーンの経由地は不合格・ANAでは非適用', () => {
  const res = run({ departure: 'HND', destination: 'BKK', outbound: ['LHR', null, null] });
  assert.ok(ng(res, 'rule4'));
  const anaRes = run({ departure: 'HND', destination: 'BKK', outbound: ['LHR', null, null] }, 'ana');
  assert.equal(codes(anaRes, 'rule4').length, 0);
});

test('[第6条] オープンジョーは往路到着地と復路出発地が同一エリアなら合格', () => {
  const okRes = run({ departure: 'HND', destination: 'CDG', returnDep: 'FRA' });
  assert.equal(codes(okRes, 'rule6.openjaw')[0].ok, true);
  const ngRes = run({ departure: 'HND', destination: 'CDG', returnDep: 'LAX' });
  assert.ok(ng(ngRes, 'rule6.openjaw'));
});

test('[非公表ルール] 同じ区間を2回飛ぶと警告（不合格にはしない）', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG', arrival: 'HIJ', outbound: ['HND', null, null], return: [null, null, null] });
  // 往路 HIJ→HND→CDG / 復路 CDG→HIJ。重複はない
  assert.equal(codes(res, 'unofficial.dup_segment').length, 0);

  const dupRes = run({
    departure: 'HND', destination: 'CDG', arrival: 'HND',
    outbound: ['ICN', null, null], return: ['ICN', null, null],
  });
  // 復路は CDG→ICN→HND なので HND→ICN の重複は起きない。ICN→CDG と CDG→ICN も別区間
  assert.equal(codes(dupRes, 'unofficial.dup_segment').length, 0);
});

test('出発地・目的地が未設定なら判定に進まない', () => {
  const res = run({ departure: 'HIJ' });
  assert.equal(res.incomplete, true);
  assert.equal(res.ok, false);
});

// =====================================================================
// 6. 代表旅程のスナップショット（抽出前後で判定の並びが変わっていないこと）
// =====================================================================

test('代表旅程（広島→パリ・羽田経由・提携）の判定内訳が固定されている', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG', outbound: ['HND', null, null] });
  assert.deepEqual(res.checks.map((c) => [c.code, c.ok]), [
    ['meta.type', 'info'],
    ['rule1', true],
    ['rule2.out', true],
    ['rule2.ret', true],
    ['rule3', true],
    ['rule4', true],
  ]);
  assert.equal(res.ok, true);
});

test('代表旅程（広島→パリ・ANA自社便・国内2回）の判定内訳が固定されている', () => {
  const res = run({ departure: 'HIJ', destination: 'CDG', outbound: ['ITM', 'HND', null] }, 'ana');
  assert.deepEqual(res.checks.map((c) => [c.code, c.ok]), [
    ['meta.type', 'info'],
    ['rule1', true],
    ['rule2.out', true],
    ['rule2.ret', true],
    ['transit.out.dom', false],
  ]);
  assert.equal(res.ok, false);
});
