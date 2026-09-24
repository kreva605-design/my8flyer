// =====================================================================
// 曜日を考慮した提案（REQ-104〜106）の単体テスト
//   cd projects/my8flyer && node --test tests/weekdays.test.mjs
// =====================================================================
// 見ているのは「実便（有償の時刻表）が何曜日に飛ぶか」であって、
// 特典で取れるかではない。テストもその線を越えない。
// =====================================================================
import test from 'node:test';
import assert from 'node:assert/strict';

import { CITIES, ALL_CARRIERS, AIRLINES, CHARTS, buildRules, loadRoutes, readJson } from './_load.mjs';
import { buildGraph, propose, legWeekdays, itineraryWeekdays, flysOn } from '../src/proposer.js';

// 便1本ぶんの作り方。days は 月火水木金土日 の7文字（1=飛ぶ / 0=飛ばない / ?=見ていない）
const fl = (no, days) => ({ no, dep: '10:00', arr: '18:00', min: 480, days });
const rec = (seen, flights, status = 'ok') => ({ status, seen, flights });

// ---------------------------------------------------------------
// REQ-104：区間の曜日 ＝ 使える社の便の OR
// ---------------------------------------------------------------
test('区間の曜日は、使える社の便を OR で足し合わせる', () => {
  const r = rec('1111111', [fl('NH001', '1000000'), fl('LH002', '0000100')]);
  const w = legWeekdays(r, ['NH', 'LH']);
  assert.equal(w.days, '1000100');
  assert.equal(w.unsure, false);
});

test('使えない社の便は曜日に数えない（乗れない便でその曜日を保証しない）', () => {
  const r = rec('1111111', [fl('NH001', '1000000'), fl('JL002', '0111111')]);
  assert.equal(legWeekdays(r, ['NH']).days, '1000000');
});

test('この特典で乗れる便が1本も無い区間は「飛ばない」（REQ-61 と同じ事実）', () => {
  const r = rec('1111111', [fl('JL252', '1111111')]);
  const w = legWeekdays(r, ['NH']);
  assert.equal(w.days, '0000000');
  assert.equal(w.reason, 'no-eligible-carrier');
});

// ---------------------------------------------------------------
// REQ-104：1日3本以上は「毎日運航」として扱う（§S-4 の実測根拠）
// ---------------------------------------------------------------
test('1日3本以上ある区間は、曜日を見ていなくても毎日運航として扱う', () => {
  const r = rec('1??????', [fl('NH1', '1??????'), fl('NH2', '1??????'), fl('NH3', '1??????')]);
  const w = legWeekdays(r, ['NH']);
  assert.equal(w.days, '1111111');
  assert.equal(w.frequent, true);
  assert.equal(w.unsure, false, '多頻度なら曜日運休は無いとみなすので、未確認扱いにしない');
});

test('境界：2本なら毎日扱いにせず、見ていない曜日は ? のまま残す', () => {
  const r = rec('1??????', [fl('NH1', '1??????'), fl('NH2', '1??????')]);
  const w = legWeekdays(r, ['NH']);
  assert.equal(w.days, '1??????');
  assert.equal(w.frequent, false);
  assert.equal(w.unsure, true);
});

test('多頻度の判定は「使える社の便」だけで数える（乗れない社の本数で毎日にしない）', () => {
  // 広島→羽田の形：JLが7本・ANAは1本。ANA特典では「毎日」と言えない
  const r = rec('1??????', [
    fl('NH672', '1??????'),
    ...Array.from({ length: 7 }, (_, i) => fl(`JL${250 + i}`, '1??????')),
  ]);
  assert.equal(legWeekdays(r, ['NH']).frequent, false, 'JLの本数でANAの曜日を保証してはいけない');
  assert.equal(legWeekdays(r, ['NH']).days, '1??????');
  assert.equal(legWeekdays(r, ['NH', 'JL']).frequent, true, '両方使えるなら多頻度でよい');
});

test('1日あたりの便数は「見た曜日」だけで数える（見ていない曜日を0本と数えない）', () => {
  // 7日ぶん見て、月曜だけ3本・他は1本 → 月曜の3本で多頻度と判定できる
  const r = rec('1111111', [fl('NH1', '1111111'), fl('NH2', '1000000'), fl('NH3', '1000000')]);
  assert.equal(legWeekdays(r, ['NH']).frequent, true);
});

// ---------------------------------------------------------------
// REQ-104：? を「飛ばない」と数えない
// ---------------------------------------------------------------
test('見ていない曜日は ? のまま残し、飛ばないと書かない', () => {
  const w = legWeekdays(rec('1??????', [fl('VN83', '1??????')]), ['VN']);
  assert.equal(w.days, '1??????');
  assert.equal(w.unsure, true);
});

test('7日ぶん見て0本なら「飛ばない」と言い切る', () => {
  const w = legWeekdays(rec('1111111', []), ['NH']);
  assert.equal(w.days, '0000000');
  assert.equal(w.unsure, false);
  assert.equal(w.reason, 'no-flights');
});

test('1日しか見ていない0本は「飛ばない」ではなく「分からない」', () => {
  const w = legWeekdays(rec('1??????', []), ['NH']);
  assert.equal(w.days, '???????');
  assert.equal(w.unsure, true);
});

test('手元に無い区間・取得できなかった区間は、断定せず未確認にする', () => {
  assert.equal(legWeekdays(null, ['NH']).days, '???????');
  assert.equal(legWeekdays(undefined, ['NH']).reason, 'no-record');
  assert.equal(legWeekdays({ status: 'error' }, ['NH']).days, '???????');
});

// ---------------------------------------------------------------
// REQ-104：旅程の曜日 ＝ 区間の AND
// ---------------------------------------------------------------
const legsOf = (...pairs) => pairs.map(([from, to, airlines]) => ({ from, to, airlines }));

test('旅程の曜日は区間の AND（1区間でも飛ばない日は旅程として飛べない）', () => {
  const flights = {
    'HND-HAN': rec('1111111', [fl('NH1', '1111111')]),
    'HAN-AMS': rec('1111111', [fl('VN83', '0100010')]),
  };
  const w = itineraryWeekdays(legsOf(['HND', 'HAN', ['NH']], ['HAN', 'AMS', ['VN']]), flights);
  assert.equal(w.days, '0100010', '火・土しか飛べない');
  assert.equal(w.unsure, false);
});

test('「飛ばない」が無く「見ていない」が混ざるときは断定せず ? を残す', () => {
  const flights = {
    'HND-HAN': rec('1111111', [fl('NH1', '1111111')]),
    'HAN-AMS': rec('1??????', [fl('VN83', '1??????')]),
  };
  const w = itineraryWeekdays(legsOf(['HND', 'HAN', ['NH']], ['HAN', 'AMS', ['VN']]), flights);
  assert.equal(w.days, '1??????');
  assert.equal(w.unsure, true);
  assert.deepEqual(w.unsureLegs, ['HAN-AMS'], 'どの区間が未確認かを言えること');
});

test('飛ばない日は、未確認の区間があっても 0 のまま（? に緩めない）', () => {
  const flights = {
    'HND-HAN': rec('1111111', [fl('NH1', '1011111')]),    // 火曜だけ運休（7日ぶん見た）
    'HAN-AMS': rec('1??????', [fl('VN83', '1??????')]),   // 月曜しか見ていない
  };
  const w = itineraryWeekdays(legsOf(['HND', 'HAN', ['NH']], ['HAN', 'AMS', ['VN']]), flights);
  assert.equal(w.days[0], '1', '月曜は両方とも飛ぶと分かっている');
  assert.equal(w.days[1], '0', '火曜は HND-HAN が運休なので、相手が未確認でも飛べない');
  assert.equal(w.days[2], '?', '水曜は HND-HAN は飛ぶが HAN-AMS を見ていない');
});

test('乗れる便が無い区間があると、その旅程は全曜日 0 になり、原因の区間が分かる', () => {
  const flights = {
    'HIJ-HND': rec('1111111', [fl('JL252', '1111111')]),
    'HND-CDG': rec('1111111', [fl('NH215', '1111111')]),
  };
  const w = itineraryWeekdays(legsOf(['HIJ', 'HND', ['NH']], ['HND', 'CDG', ['NH']]), flights);
  assert.equal(w.days, '0000000');
  assert.deepEqual(w.blockedLegs, ['HIJ-HND']);
});

test('実便を持っていなければ曜日を出さない（推測で埋めない）', () => {
  assert.equal(itineraryWeekdays(legsOf(['HND', 'CDG', ['NH']]), null), null);
  assert.equal(itineraryWeekdays([], {}), null);
});

// ---------------------------------------------------------------
// REQ-105：絞り込みは「見ていない」を理由に候補を消さない
// ---------------------------------------------------------------
test('曜日の絞り込みは、未確認の候補を落とさない', () => {
  const sure   = { days: '0100010' };     // 火・土
  const unsure = { days: '1??????' };     // 月は飛ぶ・他は未確認
  assert.equal(flysOn(sure, 1), true,  '火曜は飛ぶ');
  assert.equal(flysOn(sure, 0), false, '月曜は飛ばないと分かっている');
  assert.equal(flysOn(unsure, 2), true, '水曜は未確認＝消さずに残す');
  assert.equal(flysOn(null, 3), true,  '曜日そのものが分からなければ残す');
});

// ---------------------------------------------------------------
// 実データでの裏取り（索引が壊れたら気づけるように）
// ---------------------------------------------------------------
test('実データ：ハノイ→アムステルダムは火・土の週2便（月曜で探すと0件になる区間）', () => {
  const db = readJson('data/flights.json');
  const w = legWeekdays(db.legs['HAN-AMS'], ['VN']);
  assert.equal(w.days, '0100010');
  assert.equal(w.unsure, false, '7日ぶん見た区間なので断定できる');
});

test('実データ：羽田→パリは「区間としては多頻度」でも、ANA便だけなら毎日扱いにできない', () => {
  // 区間の総便数で数えると毎日になるが、ANA特典で乗れるのは NH の1本だけ。
  // 乗れない社の本数で曜日を保証しないことを、実データで固定する
  const db = readJson('data/flights.json');
  const all = db.legs['HND-CDG'].flights;
  const nh = all.filter((f) => f.no.startsWith('NH')).length;
  assert.ok(all.length >= 3 && nh > 0 && nh < 3,
    `前提が変わった：全${all.length}便・うちANA ${nh}便`);
  assert.equal(legWeekdays(db.legs['HND-CDG'], ['NH']).frequent, false);
  assert.equal(legWeekdays(db.legs['HND-CDG'], ['NH']).unsure, true,
    '1日ぶんしか見ていない薄い区間なので、曜日は断定しない');
});

test('実データ：広島→羽田はANA便だけでも1日3本以上あるので毎日扱いでよい', () => {
  const db = readJson('data/flights.json');
  const nh = db.legs['HIJ-HND'].flights.filter((f) => f.no.startsWith('NH')).length;
  assert.ok(nh >= 3, `前提が変わった：ANA便 ${nh}本`);
  assert.equal(legWeekdays(db.legs['HIJ-HND'], ['NH']).days, '1111111');
  assert.equal(legWeekdays(db.legs['HIJ-HND'], ['NH']).frequent, true);
});

// ---------------------------------------------------------------
// propose() への結線
// ---------------------------------------------------------------
const rules = buildRules();
const graph = buildGraph(loadRoutes(), CITIES, { carriers: ALL_CARRIERS });
const baseCtx = { rules, charts: CHARTS, cities: CITIES, graph, airlines: AIRLINES,
                  coords: readJson('data/airports.json').airports };

test('propose は実便を渡されたときだけ候補に曜日を付ける', () => {
  const req = { origin: 'HND', destination: 'CDG', wantStopover: true };
  const without = propose(req, baseCtx).proposals;
  assert.ok(without.length > 0, '候補が0件では検査にならない');
  assert.equal(without[0].weekdays, null, '実便が無ければ曜日を出さない');

  const flights = readJson('data/flights.json').legs;
  const withF = propose(req, { ...baseCtx, flights }).proposals;
  assert.ok(withF.length > 0);
  for (const p of withF) {
    assert.ok(p.weekdays && /^[01?]{7}$/.test(p.weekdays.days), `曜日の形が違う: ${p.weekdays?.days}`);
    assert.equal(p.weekdays.legs.length, p.carriersByLeg.length, '区間の数が合っていない');
  }
});

test('曜日を付けても候補の数は変わらない（曜日で候補を消さない）', () => {
  const req = { origin: 'HND', destination: 'CDG', wantStopover: true };
  const flights = readJson('data/flights.json').legs;
  const a = propose(req, baseCtx).proposals.length;
  const b = propose(req, { ...baseCtx, flights }).proposals.length;
  assert.equal(a, b);
});
