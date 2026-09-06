// =====================================================================
// miles-core — 旅程に必要なマイル数を求める純粋関数
// =====================================================================
// 副作用なし・DOM 非依存。提案（proposer）が候補を安い順に並べるために使う。
//
// チャートの正本：
//   data/mile-chart-partner.json（提携航空会社特典・ゾーンペア・99ペア）
//   data/mile-chart-ana.json    （ANA国際線特典・ゾーンペア×シーズン・24ペア）
// どちらも scripts/my8flyer/fetch_mile_charts.py が公式ページから取得し、
// 「片道×2 == 往復」を全セルで自己検算してから書き出したもの。
//
// ⚠️ index.html の MILE_CHART（旧・1本だけのチャート）とは別物。
//    旧チャートは公式との実測比較で 46セル中22セルが不一致だった。
// =====================================================================

// クラスの指定（提携チャートは premium_eco を持たない）
export const CABINS = ['eco', 'premium_eco', 'biz', 'first'];
// シーズン（ANA自社便のみ。提携チャートはシーズン区分を持たない）
export const SEASONS = ['low', 'regular', 'high'];

// =====================================================================
// 日本のゾーンが 1-A か 1-B か（提携特典のみ）
// =====================================================================
// 公式の定義（原文）：
//   「Zone 1-A」国際線往復2区間のみの旅程、国際線往復2区間に加え
//               日本国内のみで乗り継ぎをしている旅程。
//   「Zone 1-B」Zone 1-Aの設定がない場合、Zone 1-Bが適用になります。
//
// 8flyer は周遊を作るツールなので、成果物は原則すべて 1-B 側になる。
// 判定に迷うときは 1-B（＝必要マイルが多い側）へ倒す。安く見せて
// 予約時に足りないより、高く見せて選ばれないほうが害が小さいため。
// =====================================================================
export function japanZoneKey(itinerary, cities) {
  const findCity = (iata) => cities.find((c) => c.iata === iata) ?? null;
  const conns = [
    ...(itinerary.outbound ?? []).map((v, i) => ({ iata: v, so: !!(itinerary.outboundSO ?? [])[i] })),
    ...(itinerary.return   ?? []).map((v, i) => ({ iata: v, so: !!(itinerary.returnSO   ?? [])[i] })),
  ].filter((c) => c.iata);

  // 途中降機（24時間を超える滞在）は「乗り継ぎ」ではないので 1-A の条件から外れる
  if (conns.some((c) => c.so)) return '1-B';
  // 海外での乗り継ぎがあれば 1-B
  if (conns.some((c) => findCity(c.iata)?.type === 'overseas')) return '1-B';
  // 出発地と帰着地が違う（日本国内のオープンジョー）場合も往復2区間ではない
  if (itinerary.arrival && itinerary.arrival !== itinerary.departure) return '1-B';
  // 往路到着地と復路出発地が違う（海外のオープンジョー）場合も同様に扱う。
  // 原文の「国際線往復2区間のみの旅程」が、行き先と帰り元が別都市の旅程を
  // 含むかは読み取れない。含まないほう＝1-B（必要マイルが多い側）へ倒す
  if (itinerary.returnDep && itinerary.returnDep !== itinerary.destination) return '1-B';
  return '1-A';
}

function pickPartner(chart, key, cabin, revision) {
  const cell = chart?.roundtrip?.[key];
  if (!cell) return null;
  const v = cell[cabin]?.[revision];
  return typeof v === 'number' ? v : null;
}

function pickAna(chart, key, cabin, season, revision) {
  const cell = chart?.roundtrip?.[key];
  if (!cell) return null;
  const v = cell[cabin]?.[season]?.[revision];
  return typeof v === 'number' ? v : null;
}

// =====================================================================
// requiredMiles — 旅程1本の必要マイル
// =====================================================================
// opts = { awardType, charts:{partner, ana}, cities, cabin, season, revision }
//   revision : 'after'（2026-05-19 搭乗分〜の改定後・既定）／'before'
// 戻り値 = { miles, zoneKey, breakdown[], note } または
//          { miles: null, reason }（チャートに無い・対象外）
//
// 値が取れないときに 0 や推定値を返さない。並べ替えの土台が推定値だと、
// 「安い順」の先頭が実在しない候補になるため。
// =====================================================================
export function requiredMiles(itinerary, opts) {
  const { awardType = 'partner', charts, cities } = opts;
  const cabin    = opts.cabin ?? 'eco';
  const season   = opts.season ?? 'regular';
  const revision = opts.revision ?? 'after';

  if (!charts?.partner || !charts?.ana) throw new Error('charts（2本のマイルチャート）が必要です');
  if (!Array.isArray(cities)) throw new Error('cities（都市マスタ）が必要です');
  if (!CABINS.includes(cabin))   throw new Error(`未知のクラス: ${cabin}`);
  if (!SEASONS.includes(season)) throw new Error(`未知のシーズン: ${season}`);

  const findCity = (iata) => cities.find((c) => c.iata === iata) ?? null;
  const depCity  = findCity(itinerary.departure);
  const destCity = findCity(itinerary.destination);
  if (!depCity || !destCity) return { miles: null, reason: '都市マスタに無い空港が含まれています' };
  if (depCity.type !== 'domestic') return { miles: null, reason: '本ツールは日本発の旅程のみ対応しています' };

  // オープンジョー（往路到着地と復路出発地が違う）は各ゾーンの半分ずつを合算する
  const retDepCity = itinerary.returnDep ? findCity(itinerary.returnDep) : null;
  const isOpenJaw  = !!(retDepCity && retDepCity.iata !== destCity.iata);
  const legZones   = isOpenJaw ? [destCity.zone, retDepCity.zone] : [destCity.zone];

  if (awardType === 'ana') {
    const parts = legZones.map((z) => ({ zone: z, key: `1|${z}`,
      value: pickAna(charts.ana, `1|${z}`, cabin, season, revision) }));
    const missing = parts.find((p) => p.value == null);
    if (missing) {
      return { miles: null,
        reason: `ANA自社便のチャートに Zone ${missing.zone} × ${cabin}（${season}）の値がありません` };
    }
    if (!isOpenJaw) {
      return { miles: parts[0].value, zoneKey: parts[0].key,
        breakdown: [{ label: `Zone 1 ⇄ Zone ${parts[0].zone}`, miles: parts[0].value }],
        note: `${season} シーズン・改定${revision === 'after' ? '後' : '前'}` };
    }
    const halves = parts.map((p) => ({ ...p, half: Math.round(p.value / 2) }));
    return {
      miles: halves.reduce((a, h) => a + h.half, 0),
      zoneKey: halves.map((h) => h.key).join(' + '),
      breakdown: halves.map((h) => ({ label: `Zone ${h.zone} の半分`, miles: h.half })),
      note: 'オープンジョー（各ゾーンの必要マイルの1/2を合算）',
    };
  }

  // 提携航空会社特典
  const zoneKey = japanZoneKey(itinerary, cities);
  const parts = legZones.map((z) => ({ zone: z, key: `${zoneKey}|${z}`,
    value: pickPartner(charts.partner, `${zoneKey}|${z}`, cabin, revision) }));
  const missing = parts.find((p) => p.value == null);
  if (missing) {
    return { miles: null,
      reason: `提携チャートに ${missing.key} × ${cabin} の値がありません` };
  }
  const zoneNote = zoneKey === '1-B'
    ? '日本は Zone 1-B（海外での乗り継ぎ・途中降機・国内オープンジョーを含む旅程）'
    : '日本は Zone 1-A（国際線往復2区間のみ、または日本国内だけの乗り継ぎ）';
  if (!isOpenJaw) {
    return { miles: parts[0].value, zoneKey: parts[0].key,
      breakdown: [{ label: `Zone ${zoneKey} ⇄ Zone ${parts[0].zone}`, miles: parts[0].value }],
      note: zoneNote };
  }
  const halves = parts.map((p) => ({ ...p, half: Math.round(p.value / 2) }));
  return {
    miles: halves.reduce((a, h) => a + h.half, 0),
    zoneKey: halves.map((h) => h.key).join(' + '),
    breakdown: halves.map((h) => ({ label: `Zone ${h.zone} の半分`, miles: h.half })),
    note: `${zoneNote}／オープンジョー（各ゾーンの必要マイルの1/2を合算）`,
  };
}
