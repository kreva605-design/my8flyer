// つながる便の組み合わせ（src/combos.js）の検算。
//   node --test tests/combos.test.mjs
// 見たいのは「組み合わせが出るか」ではなく、**落とすべきものを落とし、落としてはいけないものを残すか**。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { toMin, arrDayShift, connectRule, buildCombos, pickThree, fmtDur, SLACK_CAP }
  from '../src/combos.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const MCT = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/mct-ana.json'), 'utf8'));
const FLIGHTS = JSON.parse(fs.readFileSync(path.join(ROOT, 'data/flights.json'), 'utf8')).legs;
const JP = new Set(['HIJ', 'HND', 'NRT', 'KIX', 'ITM', 'NGO', 'OKA', 'FUK', 'CTS', 'UKB']);
const isJapan = (i) => JP.has(i);
const STAR = ['NH', 'UA', 'LH', 'LX', 'SQ', 'TG', 'OZ', 'AI', 'TK', 'AC', 'CA', 'NZ',
              'OS', 'TP', 'BR', 'SN', 'ET', 'LO', 'A3', 'OU', 'MS', 'SA', 'ZH', 'AV', 'CM'];

// ---------------------------------------------------------------- 時刻の読み

test('日をまたぐ到着を分に直せる', () => {
  assert.equal(toMin('07:35'), 455);
  assert.equal(toMin('17:55+1'), 1440 + 1075);
  assert.equal(arrDayShift('17:55+1'), 1);
  assert.equal(arrDayShift('08:55'), 0);
  assert.equal(toMin('こわれた'), null);
});

// ---------------------------------------------------------------- 必要時間の選び方

test('羽田の国内→国際は、ターミナルが分からないので厳しいほう（70分）を使う', () => {
  const r = connectRule('HND', false, true, MCT, isJapan);
  assert.equal(r.minutes, 70);          // 第2の55分ではない
  assert.equal(r.source, 'official');
  assert.equal(r.hard, true);
});

test('羽田の国際→国内は80分・落とす根拠になる', () => {
  const r = connectRule('HND', true, false, MCT, isJapan);
  assert.equal(r.minutes, 80);
  assert.equal(r.hard, true);
});

test('海外の空港は8flyerの既定値120分で、落とす根拠にはしない', () => {
  const r = connectRule('LHR', true, true, MCT, isJapan);
  assert.equal(r.minutes, 120);
  assert.equal(r.source, 'default');
  assert.equal(r.hard, false, '既定値はMCTではないので、下回っても落としてはいけない');
});

test('ANA公式の表に無い日本の空港も、落とす根拠にはしない', () => {
  const r = connectRule('FUK', false, true, MCT, isJapan);   // 福岡の国内→国際は表に無い
  assert.equal(r.source, 'default');
  assert.equal(r.hard, false);
});

test('国内→国内は公式値（羽田35分）', () => {
  const r = connectRule('HND', false, false, MCT, isJapan);
  assert.equal(r.minutes, 35);
  assert.equal(r.hard, true);
});

// ---------------------------------------------------------------- 実データで組む

const legsOut = [
  { from: 'HIJ', to: 'HND', eligible: STAR },
  { from: 'HND', to: 'LHR', eligible: STAR },
  { from: 'LHR', to: 'LIS', eligible: STAR },
];
const run = (stopovers, extra = {}) => buildCombos({
  legs: legsOut, flights: FLIGHTS, mct: MCT, isJapan,
  stopovers: new Set(stopovers), ...extra,
});

test('実データで往路の組み合わせが出る（ロンドンに泊まらない案）', () => {
  const r = run([]);
  assert.equal(r.ok, true);
  assert.ok(r.plans.length > 0, '組み合わせが1つも出ないのはおかしい');
  assert.equal(r.counts.capped, false, '枝刈りが効かず打ち切られている');
});

test('★羽田で乗れない乗り継ぎを出さない（ANA公式70分を下回る組が残っていない）', () => {
  const r = run([]);
  for (const p of r.plans) {
    const hnd = p.conns.find((c) => c.via === 'HND');
    assert.ok(hnd.minutes >= 70, `羽田 ${hnd.minutes}分 の組が残っている`);
  }
});

test('★とまる予定でない街で24時間以上あく組を出さない', () => {
  const r = run([]);
  for (const p of r.plans) {
    for (const c of p.conns) {
      assert.ok(c.minutes < 1440, `${c.via} で ${c.minutes}分 とまる組が残っている`);
    }
  }
});

test('★ロンドンに泊まる指定をすると、24時間以上の案だけになる', () => {
  const r = run(['LHR']);
  assert.ok(r.plans.length > 0);
  for (const p of r.plans) {
    const lhr = p.conns.find((c) => c.via === 'LHR');
    assert.ok(lhr.isStopover, 'ロンドン指定なのに24時間未満の案が混じっている');
    assert.ok(lhr.minutes >= 1440);
  }
});

test('★泊まる指定の有無で、出てくる案が入れ替わる（同じものを出していない）', () => {
  const a = new Set(run([]).plans.map((p) => p.legs.map((l) => `${l.no}@${l.depDay}`).join('|')));
  const b = new Set(run(['LHR']).plans.map((p) => p.legs.map((l) => `${l.no}@${l.depDay}`).join('|')));
  const overlap = [...a].filter((k) => b.has(k));
  assert.equal(overlap.length, 0, '泊まる案と泊まらない案が混ざっている');
});

test('★既定値（120分）を下回る海外の乗り継ぎは、落とさず印を付ける', () => {
  // リスボン→ロンドン→羽田。TP1356 着17:30 → NH212 19:00 は90分で既定値に30分たりない
  const r = buildCombos({
    legs: [{ from: 'LIS', to: 'LHR', eligible: STAR }, { from: 'LHR', to: 'HND', eligible: STAR }],
    flights: FLIGHTS, mct: MCT, isJapan, stopovers: new Set(),
  });
  const tight = r.plans.find((p) => p.legs[0].no === 'TP1356');
  assert.ok(tight, 'TP1356 の案が落とされている（既定値は落とす根拠にしてはいけない）');
  assert.equal(tight.softNg, true, '短いことに印が付いていない');
  assert.equal(tight.conns[0].ok, false);
  assert.equal(tight.conns[0].hard, false);
});

test('合計時間は「飛んだ時間＋乗り継ぎ時間」で、時差の影響を受けない', () => {
  const r = run([]);
  for (const p of r.plans) {
    const fly = p.legs.reduce((a, l) => a + l.min, 0);
    const conn = p.conns.reduce((a, c) => a + c.minutes, 0);
    assert.equal(p.totalMin, fly + conn);
  }
});

test('日ずらしは指定した日数まで', () => {
  const r = run(['LHR'], { maxDayShift: 1 });
  for (const p of r.plans) {
    const last = p.legs[p.legs.length - 1];
    assert.ok(last.depDay <= 3, `${last.depDay}日目に出る案が残っている`);
  }
});

// ---------------------------------------------------------------- 3案の選び方

test('性格の違う3案が選ばれ、同じ組み合わせは重ならない', () => {
  const r = run(['LHR']);
  const picked = r.picked;
  assert.ok(picked.length >= 1 && picked.length <= 3);
  const keys = picked.map((p) => p.plan.legs.map((l) => `${l.no}@${l.depDay}`).join('|'));
  assert.equal(new Set(keys).size, keys.length, '同じ案が2回出ている');
});

test('「最短で着く」は本当にいちばん短い', () => {
  const r = run([]);
  const shortest = r.picked.find((p) => p.kind === 'shortest');
  const min = Math.min(...r.plans.map((p) => p.totalMin));
  assert.equal(shortest.plan.totalMin, min);
});

test('★「余裕がある」が、空港で1泊する案を選ばない', () => {
  // 余裕に上限を付けないと、羽田で23時間待つ案が「いちばん余裕がある」になる
  const r = run([]);
  const relaxed = r.picked.find((p) => p.kind === 'relaxed');
  const cap = (p) => Math.min(p.slackMin, SLACK_CAP);
  const best = Math.max(...r.plans.map(cap));
  assert.equal(cap(relaxed.plan), best);
  // 上限に達している案が複数あるなら、そのうち合計が最短のものが選ばれる
  const tied = r.plans.filter((p) => cap(p) === best);
  assert.equal(relaxed.plan.totalMin, Math.min(...tied.map((p) => p.totalMin)));
  const longest = Math.max(...relaxed.plan.conns.filter((c) => !c.isStopover).map((c) => c.minutes));
  assert.ok(longest < 1440, `${longest}分の乗り継ぎを「余裕がある」として出している`);
});

test('「寄り道に長くいられる」は本当にいちばん長くとまる', () => {
  const r = run(['LHR']);
  const longest = r.picked.find((p) => p.kind === 'longest');
  const max = Math.max(...r.plans.map((p) => p.stopoverMin));
  assert.equal(longest.plan.stopoverMin, max);
});

// ---------------------------------------------------------------- 出せないとき

test('乗れる便が無い区間があれば、空の組み合わせを出さず理由を返す', () => {
  const r = buildCombos({
    legs: [{ from: 'HND', to: 'LHR', eligible: ['XX'] }],   // 乗れる社がない
    flights: FLIGHTS, mct: MCT, isJapan, stopovers: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason.join(''), /乗れる便がない/);
  assert.equal(r.plans.length, 0);
});

test('便データが無い区間も、黙って0件にしない', () => {
  const r = buildCombos({
    legs: [{ from: 'AAA', to: 'BBB', eligible: STAR }],
    flights: FLIGHTS, mct: MCT, isJapan, stopovers: new Set(),
  });
  assert.equal(r.ok, false);
  assert.match(r.reason.join(''), /便データがない/);
});

test('時間の表示', () => {
  assert.equal(fmtDur(70), '1時間10分');
  assert.equal(fmtDur(1605), '1日2時間45分');
  assert.equal(fmtDur(0), '0分');
});
