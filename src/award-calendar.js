// ANA特典カレンダーの読み取り結果を、アプリが使う形（区間 → 180文字の空席列）に変換する。
//
// 拡張（content_cal.js）はANAのページのDOMを読んで「路線名・方向・日付・記号」までを作る。
// **路線名→空港コードの対応づけはここで行う**。都市マスタ（CITIES）を持っているのはアプリ側
// だけなので、対応表を拡張にも書くと二重管理になり、片方だけ古くなる。
//
// 目安であって実在庫ではない（ANA公式が「実際の予約可能座席数と異なる場合があります」と明記）。
// 対象は日本発着のANA自社便のみ。載っていない区間は **入れない**（0日と区別するため）。

// 公式の凡例（alt に日本語で意味が入っている）→ 1文字コード。
// ★「十分空席あり」は「空席あり」を含むので、長いほうから先に判定する
const LABEL_TO_CODE = [
  ['十分空席あり', '3'],
  ['空席あり', '2'],
  ['残席わずか', '1'],
  ['ご利用いただけない', '0'],
  ['キャンペーン', '4'],
];

export function labelToCode(label) {
  for (const [needle, code] of LABEL_TO_CODE) if (label.includes(needle)) return code;
  return '0';
}

const norm = (s) => String(s ?? '')
  .replace(/（/g, '(').replace(/）/g, ')').replace(/　/g, ' ').trim();

/** 都市マスタから「名前 → IATA」の索引を作る。括弧を外した形も引けるようにする。 */
export function buildCityIndex(cities) {
  const idx = new Map();
  for (const c of cities ?? []) {
    if (!c?.iata || !c?.name) continue;
    const n = norm(c.name);
    if (!idx.has(n)) idx.set(n, c.iata);
    const bare = n.replace(/\([^)]*\)/g, '').trim();
    if (bare && !idx.has(bare)) idx.set(bare, c.iata);
  }
  return idx;
}

/**
 * 路線名の片側を IATA に解決する。**推測しない。引けなければ null。**
 *   「パリ(CDG)」  → 括弧内が3文字コードならそれを使う
 *   「フランクフルト」→ 都市マスタで引く
 *   「ロンドン(ヒースロー)」→ 括弧を外して引く
 */
export function resolveAirport(part, cityIndex) {
  const p = norm(part);
  const m = p.match(/\(([A-Z]{3})\)/);
  if (m) return m[1];
  if (cityIndex.has(p)) return cityIndex.get(p);
  const bare = p.replace(/\([^)]*\)/g, '').trim();
  return cityIndex.get(bare) ?? null;
}

/**
 * 拡張が読み取った payload を、アプリが使う形に変換する。
 *
 * payload: { _meta, dates:[ISO…], rows:[{route, direction:'日本発'|'日本着', codes:'3312…'}] }
 * 戻り値 : { _meta, legs:{ 'HND-CDG': {dir:'out', avail:'3312…'} }, unresolved:[路線名…] }
 *
 * ★空港コードに落とせない路線は legs に入れず unresolved に積む。黙って捨てると
 *   「面が無い」のか「空きが無い」のか区別できなくなる。呼び手が必ず見ること。
 */
export function toLegs(payload, cities) {
  const idx = buildCityIndex(cities);
  const legs = {};
  const unresolved = new Set();

  for (const row of payload?.rows ?? []) {
    const parts = String(row.route ?? '').trim().split(/\s+/);
    if (parts.length < 2) { unresolved.add(row.route); continue; }
    const jp = resolveAirport(parts[0], idx);
    const ov = resolveAirport(parts.slice(1).join(' '), idx);
    if (!jp || !ov) { unresolved.add(row.route); continue; }

    const isOut = row.direction === '日本発';
    const key = isOut ? `${jp}-${ov}` : `${ov}-${jp}`;
    legs[key] = { dir: isOut ? 'out' : 'in', avail: row.codes };
  }

  const dates = payload?.dates ?? [];
  return {
    _meta: {
      ...(payload?._meta ?? {}),
      is_estimate: true,
      note: '目安であって実在庫ではない。確定は特典航空券予約の空席照会で行う。'
          + '対象は日本発着のANA自社便のみ（提携社運航・海外↔海外・国内線は載らない）。',
      legend: { 0: '利用不可', 1: '残席わずか（空席待ち可）', 2: '空席あり',
                3: '十分空席あり', 4: 'キャンペーン（要確認）' },
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      days: dates.length,
    },
    legs,
    unresolved: [...unresolved],
  };
}
