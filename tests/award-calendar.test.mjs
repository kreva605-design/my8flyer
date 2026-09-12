// 特典カレンダーの取り込み（拡張の読み取り結果 → アプリが使う形）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CITIES } from './_load.mjs';
import { labelToCode, resolveAirport, buildCityIndex, toLegs } from '../src/award-calendar.js';

const idx = buildCityIndex(CITIES);

test('凡例の alt を1文字コードにする', () => {
  assert.equal(labelToCode('十分空席あり'), '3');
  assert.equal(labelToCode('空席あり'), '2');
  assert.equal(labelToCode('残席わずか、空席待ち'), '1');
  assert.equal(labelToCode('ご利用いただけない期間'), '0');
  assert.equal(labelToCode('キャンペーン期間につき空席照会画面を ご確認ください'), '4');
});

test('「十分空席あり」を「空席あり」と取り違えない', () => {
  // 「空席あり」は「十分空席あり」の部分文字列。長いほうから判定しないと全部 2 になる
  assert.notEqual(labelToCode('十分空席あり'), '2');
});

test('路線名を空港コードに落とす（3通りの引き方）', () => {
  assert.equal(resolveAirport('パリ(CDG)', idx), 'CDG');          // 括弧内のコード
  assert.equal(resolveAirport('フランクフルト', idx), 'FRA');       // 都市マスタそのまま
  assert.equal(resolveAirport('ロンドン(ヒースロー)', idx), 'LHR'); // 括弧を外して引く
  assert.equal(resolveAirport('東京(羽田)', idx), 'HND');          // 全角括弧のゆれを吸収
  assert.equal(resolveAirport('東京(成田)', idx), 'NRT');
});

test('引けない路線名は推測せず null を返す', () => {
  assert.equal(resolveAirport('架空の街', idx), null);
});

test('方向をキーの向きに落とす（日本発＝出国側）', () => {
  const p = { dates: ['2026-09-05', '2026-09-06'], rows: [
    { route: '東京(羽田) パリ(CDG)', direction: '日本発', codes: '32' },
    { route: '東京(羽田) パリ(CDG)', direction: '日本着', codes: '13' },
  ]};
  const r = toLegs(p, CITIES);
  assert.deepEqual(r.legs['HND-CDG'], { dir: 'out', avail: '32' });
  assert.deepEqual(r.legs['CDG-HND'], { dir: 'in',  avail: '13' });
});

test('落とせない路線は legs に入れず unresolved に積む', () => {
  // ★黙って捨てると「面が無い」のか「空きが無い」のか区別できなくなる
  const p = { dates: ['2026-09-05'], rows: [
    { route: '東京(羽田) 架空の街', direction: '日本発', codes: '3' },
    { route: '東京(羽田) パリ(CDG)', direction: '日本発', codes: '2' },
  ]};
  const r = toLegs(p, CITIES);
  assert.deepEqual(Object.keys(r.legs), ['HND-CDG']);
  assert.deepEqual(r.unresolved, ['東京(羽田) 架空の街']);
});

test('目安であることを必ず持たせる', () => {
  const r = toLegs({ dates: ['2026-09-05'], rows: [] }, CITIES);
  assert.equal(r._meta.is_estimate, true);
  assert.match(r._meta.note, /実在庫ではない/);
  assert.equal(r._meta.days, 1);
});
