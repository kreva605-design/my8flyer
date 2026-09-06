// =====================================================================
// proposer — 目的地を決めると、規約に適合するルート候補を並べて返す
// =====================================================================
// このアプリの本質は「同じマイルで、もう1都市」＝寄り道1回をどこに使うかの提案。
// 白紙の8スロットに人が都市を埋める代わりに、ここが候補を列挙する。
//
// 設計上の約束（守ること）：
//  - 合否の判定は必ず rules-core の validateItinerary() を通す。
//    ここに「第1条はこうだから」という判定を書き写さない。
//    片方だけ直したときに欠陥が下流へ移るため（探索の枝刈りは
//    「明らかに落ちる枝を先に切る」高速化であって、合否判定ではない）。
//  - 必要マイルは miles-core が出した値だけを使う。取れない候補は
//    推定値で埋めず、miles=null のまま末尾に置く。
// =====================================================================
import { ZONE_RANK, validateItinerary } from './rules-core.js';
import { requiredMiles } from './miles-core.js';
import { pathDistanceKm } from './geo.js';

// =====================================================================
// buildGraph — routes.json から「乗り継ぎに使える区間」だけの隣接表を作る
// =====================================================================
// 特典航空券で乗れるのは ANA と提携航空会社の便だけなので、
// 全58,089区間のうち対象社が運航する区間に絞る。
// さらに都市マスタ（CITIES）に無い空港は、ゾーンが分からず規約判定に
// かけられないため落とす。
// =====================================================================
// carriers には「この案件で乗りうる社すべて」（＝ANA自社便＋スタアラ＋ANA提携社）を渡す。
// 特典の種類ごとの絞り込みは探索時に行う（グラフを2本持つと片方だけ直す事故が起きる）。
export function buildGraph(routesJson, cities, opts = {}) {
  const carriers = opts.carriers;         // Set<string>
  if (!carriers || typeof carriers.has !== 'function') {
    throw new Error('opts.carriers（運航キャリアの集合）が必要です');
  }
  const known = new Set(cities.map((c) => c.iata));
  // グループ空港（TYO=HND/NRT）は routes.json 側に無いので実空港へ読み替える
  const groupOf = new Map();
  cities.forEach((c) => (c.group ?? []).forEach((m) => groupOf.set(m, c.iata)));

  const adj = new Map();       // from → Map(to → 運航キャリア配列)
  let kept = 0, dropped = 0;
  for (const [key, airlines] of Object.entries(routesJson)) {
    if (key.startsWith('_')) continue;
    const [rawFrom, rawTo] = key.split('-');
    if (!rawFrom || !rawTo) continue;
    const usable = airlines.filter((a) => carriers.has(a));
    if (usable.length === 0) { dropped++; continue; }
    // 実空港が都市マスタに無ければ、それを含むグループ空港へ寄せる
    const from = known.has(rawFrom) ? rawFrom : groupOf.get(rawFrom);
    const to   = known.has(rawTo)   ? rawTo   : groupOf.get(rawTo);
    if (!from || !to || from === to) { dropped++; continue; }
    if (!adj.has(from)) adj.set(from, new Map());
    const prev = adj.get(from).get(to) ?? [];
    adj.get(from).set(to, [...new Set([...prev, ...usable])]);
    kept++;
  }
  return { adj, stats: { kept, dropped, nodes: adj.size } };
}

// =====================================================================
// 片道の経路を列挙する（深さ優先・枝刈りつき）
// =====================================================================
// 枝刈りは「明らかに落ちる枝を先に切る」だけ。合否は後段の rules-core が決める。
//  - 目的地より必要マイルの高いゾーンは経由できない（第1条・第4条）
//  - 乗り継ぎ回数の上限（国内・海外それぞれ）を超えたら伸ばさない
//  - 同じ都市を2回踏まない
// =====================================================================
// ⚠️ pruneRank は「旅程の目的地」のゾーン順位であって、この片道の終点ではない。
// 復路の終点は日本（Zone 1・順位0）なので、終点で枝刈りすると海外の
// 経由地がすべて落ち、復路が「日本国内で乗り継ぐだけ」の1通りに縮む。
// 2026-09-06 に実際にこれで復路が1通りしか出ていなかった。
function enumeratePaths(adj, cities, from, to, limits, cap, pruneRank, allowed) {
  const cityOf = new Map(cities.map((c) => [c.iata, c]));
  const out = [];
  // その特典で乗れる社が1社も飛んでいない区間は、そもそも経路に使えない。
  // ★ANA国際線特典（自社便）は NH 運航便しか使えない。ここを見落とすと
  //   「羽田→グアム（UAのみ運航）」をANA自社便の提案として出してしまう
  //   （2026-09-06 に実際に28本中4本で発生していた）
  const usable = (from2, to2) => {
    const air = adj.get(from2)?.get(to2);
    return !!air && (!allowed || air.some((a) => allowed.has(a)));
  };

  const walk = (cur, visited, conns, domCnt, ovsCnt) => {
    if (out.length >= cap) return;
    const nexts = adj.get(cur);
    if (!nexts) return;
    if (usable(cur, to)) out.push([...conns]);        // ここから目的地へ直行できる
    if (conns.length >= limits.maxTransits) return;

    for (const nx of nexts.keys()) {
      if (out.length >= cap) return;
      if (nx === to || visited.has(nx)) continue;
      if (!usable(cur, nx)) continue;
      const c = cityOf.get(nx);
      if (!c) continue;
      // 第1条・第4条の先取り：目的地より高いゾーンは経由地に使えない
      if (c.type === 'overseas' && (ZONE_RANK[c.zone] ?? 0) > pruneRank) continue;
      const nd = domCnt + (c.type === 'domestic' ? 1 : 0);
      const no = ovsCnt + (c.type === 'overseas' ? 1 : 0);
      if (nd > limits.domMax || no > limits.ovsMax) continue;
      visited.add(nx);
      conns.push(nx);
      walk(nx, visited, conns, nd, no);
      conns.pop();
      visited.delete(nx);
    }
  };

  walk(from, new Set([from]), [], 0, 0);
  return out;
}

// =====================================================================
// pickRepresentativePaths — 各都市について「いちばん遠回りでない経路」だけ残す
// =====================================================================
// 経路を全部組み合わせると、羽田→パリで 573,045 組・判定 360万件になり
// 24秒かかる。しかも最後に「必要マイル × 寄り道先」で畳むので、
// 同じ寄り道先の中で選ばれるのは1本だけ。
//
// そこで組み合わせる前に、**都市ごとに最短の1本**へ絞る。
// 「その都市を通る経路が1本も無くなる」ことは起きないので、
// 提案に出てくる寄り道先の顔ぶれは変わらない（減るのは重複だけ）。
//
// ⚠️ 絞った結果は必ず stats に残す。黙って痩せた出力を正常と思い込まないため。
// =====================================================================
function pickRepresentativePaths(paths, from, to, coords) {
  if (!coords) return { paths, kept: paths.length, enumerated: paths.length };
  const scored = paths.map((conns) => ({
    conns,
    km: pathDistanceKm([from, ...conns, to], coords),
  })).filter((x) => x.km != null);
  if (scored.length === 0) return { paths, kept: paths.length, enumerated: paths.length };

  const best = new Map();                       // 都市 → 最短でその都市を通る経路
  let shortest = scored[0];
  for (const s of scored) {
    if (s.km < shortest.km) shortest = s;
    for (const c of s.conns) {
      const cur = best.get(c);
      if (!cur || s.km < cur.km) best.set(c, s);
    }
  }
  const uniq = new Map();
  const add = (s) => uniq.set(s.conns.join('>'), s);
  add(shortest);
  for (const s of best.values()) add(s);
  return {
    paths: [...uniq.values()].map((s) => s.conns),
    kept: uniq.size,
    enumerated: paths.length,
  };
}

// =====================================================================
// allowedCarriers — その特典で乗れる航空会社
// =====================================================================
// ANA国際線特典航空券（自社便）… NH 運航便のみ
// 提携航空会社特典航空券      … スターアライアンス加盟社 ＋ ANAの提携社
// airlines を渡さないと絞り込まない（旧来の挙動）。正本は data/airlines.json
// =====================================================================
export function allowedCarriers(awardType, airlines) {
  if (!airlines) return null;
  if (awardType === 'ana') return new Set(airlines.ana_own ?? ['NH']);
  return new Set([...(airlines.star_alliance ?? []), ...(airlines.ana_partners ?? [])]);
}

// 空港の「大きさ」は、特典で乗れる社が何路線飛ばしているかで測る。
// 設備としての規模（OurAirports の large/medium）とは別物で、
// 岡山も高知も large になってしまい乗り継ぎの実力を表さない
export function hubScore(graph, iata, allowed) {
  const out = graph.adj.get(iata);
  if (!out) return 0;
  let n = 0;
  for (const air of out.values()) {
    if (!allowed || air.some((a) => allowed.has(a))) n++;
  }
  return n;
}

const padSlots = (arr, n = 3) => [...arr, ...Array(Math.max(0, n - arr.length)).fill(null)].slice(0, n);
const boolSlots = (arr, n = 3) => [...arr, ...Array(Math.max(0, n - arr.length)).fill(false)].slice(0, n);

// =====================================================================
// propose — ルート候補を列挙して並べる
// =====================================================================
// req = {
//   origin, destination, arrival?, returnDep?,   // returnDep 指定でオープンジョー
//   awardType:'partner'|'ana', cabin, season, revision,
//   maxTransits,        // 片道あたりの乗り継ぎ数の上限（既定3＝スロット数）
//   wantStopover,       // true なら寄り道（途中降機）を置いた案も作る
// }
// ctx = { rules, charts, cities, graph }
// 戻り値 = { proposals:[...], stats:{...} }
//   proposals[] = { itinerary, miles, milesNote, transits, stopover, checks, route }
// =====================================================================
export function propose(req, ctx) {
  const { rules, charts, cities, graph } = ctx;
  if (!rules || !charts || !cities || !graph) {
    throw new Error('ctx に rules / charts / cities / graph が必要です');
  }
  const awardType = req.awardType ?? 'partner';
  const cfg = rules[awardType] ?? rules.partner;
  const origin      = req.origin;
  const destination = req.destination;
  const arrival     = req.arrival ?? origin;
  const retFrom     = req.returnDep ?? destination;
  const cap         = req.cap ?? 4000;         // 経路列挙の打ち切り（安全弁）

  const limits = {
    maxTransits: Math.min(req.maxTransits ?? 3, 3),   // UI のスロットが片道3つ
    domMax: cfg.transitDomMax,
    ovsMax: cfg.transitOvsMax,
  };

  // 特典の種類で乗れる社が変わる。data/airlines.json が正本
  const allowed = allowedCarriers(awardType, ctx.airlines);

  // 枝刈りの基準は旅程の目的地（オープンジョーなら両端の高いほう）。
  // 往路・復路のどちらも同じ基準を使う
  const rankOf = (iata) => ZONE_RANK[cities.find((c) => c.iata === iata)?.zone] ?? 0;
  const pruneRank = Math.max(rankOf(destination), rankOf(retFrom));

  const allOut = enumeratePaths(graph.adj, cities, origin,  destination, limits, cap, pruneRank, allowed);
  const allRet = enumeratePaths(graph.adj, cities, retFrom, arrival,     limits, cap, pruneRank, allowed);

  const coords = ctx.coords ?? null;
  const repOut = pickRepresentativePaths(allOut, origin,  destination, coords);
  const repRet = pickRepresentativePaths(allRet, retFrom, arrival,     coords);
  const outPaths = repOut.paths;

  // 帰着地を出発地と変える案（国内オープンジョー）も既定で混ぜる。
  // 「羽田発 → パリ → 沖縄着」のように、国内枠を使って
  // もう1都市に降りられる形（2026-09-06 ユーザー決定）。
  // ★海外オープンジョー（復路の出発地を目的地と変える）はやらない。
  //   選択肢が増えすぎるため、こちらもユーザーの決定。
  const retSets = [{ arrival, paths: repRet.paths }];
  if (req.domesticOpenJaw !== false && arrival === origin) {
    const airportsFor = ctx.airports ?? null;
    for (const c of cities) {
      if (c.type !== 'domestic' || c.iata === origin) continue;
      // 帰着地は就航路線が多い空港だけ。
      // 特典で乗れる社の就航先が少ない空港を帰着地にすると、
      // 実際には便が取れず提案として役に立たない
      if (hubScore(graph, c.iata, allowed) < (req.minHubRoutes ?? 8)) continue;
      const alt = enumeratePaths(graph.adj, cities, retFrom, c.iata, limits, cap, pruneRank, allowed);
      if (!alt.length) continue;
      const rep = pickRepresentativePaths(alt, retFrom, c.iata, coords);
      retSets.push({ arrival: c.iata, paths: rep.paths });
    }
  }

  const stats = {
    outPathsFound: repOut.enumerated, retPathsFound: repRet.enumerated,
    outPaths: outPaths.length, retPaths: repRet.paths.length,
    combinations: 0, validated: 0, passed: 0, milesUnknown: 0,
    truncated: allOut.length >= cap || allRet.length >= cap,
    carriers: allowed ? allowed.size : null,
  };

  const cityName = (iata) => cities.find((c) => c.iata === iata)?.name ?? iata;
  const typeOfCity = new Map(cities.map((c) => [c.iata, c.type]));
  const ovsCountOf = (it) => [...it.outbound, ...it.return]
    .filter(Boolean).filter((i) => typeOfCity.get(i) === 'overseas').length;

  // ★候補を全件ためない。
  // 「必要マイル × 寄り道先」で畳んだあとに残るのは数十本なのに、
  // 畳む前を配列で持つと数百万件になり、実際にメモリを使い切って落ちた
  //（2026-09-06・路線グラフに提携社の114区間を足した直後）。
  // そこで**その場で代表を選びながら**進める。順序の基準（総飛行距離）は
  // 基準値を引く前でも大小が変わらないので、これで同じ結果になる。
  const keep = new Map();        // key -> 代表の案
  let minKm = null;              // 全体の最短（参考）
  let homeKm = null;             // ★基準＝「まっすぐ帰る」旅程の最短飛行距離。
                                 //   帰着地ごとに基準を取ると、どの帰着地でも
                                 //   +0km になって並べられなくなる（実測で確認）。
                                 //   「まっすぐ帰るより何km多く飛ぶか」で統一する

  for (const op of outPaths) {
   for (const { arrival: arv, paths: rps } of retSets) {
    for (const rp of rps) {
      stats.combinations++;
      const soPlacements = [null];
      if (req.wantStopover) {
        op.forEach((_, i) => soPlacements.push({ leg: 'out', idx: i }));
        rp.forEach((_, i) => soPlacements.push({ leg: 'ret', idx: i }));
      }

      for (const so of soPlacements) {
        const itinerary = {
          departure: origin,
          destination,
          arrival: arv === origin ? null : arv,
          returnDep: retFrom === destination ? null : retFrom,
          outbound: padSlots(op),
          return: padSlots(rp),
          outboundSO: boolSlots(op.map((_, i) => so?.leg === 'out' && so.idx === i)),
          returnSO:   boolSlots(rp.map((_, i) => so?.leg === 'ret' && so.idx === i)),
          outboundSurfaceAfter: [false, false, false],
          returnSurfaceAfter:   [false, false, false],
        };

        stats.validated++;
        const res = validateItinerary(itinerary, { awardType, rules, cities });
        if (!res.ok) continue;
        stats.passed++;

        const m = requiredMiles(itinerary, {
          awardType, charts, cities,
          cabin: req.cabin, season: req.season, revision: req.revision,
        });
        if (m.miles == null) stats.milesUnknown++;

        const soIata = so ? (so.leg === 'out' ? op[so.idx] : rp[so.idx]) : null;
        const kmOut = coords ? pathDistanceKm([origin, ...op, destination], coords) : null;
        const kmRet = coords ? pathDistanceKm([retFrom, ...rp, arv], coords) : null;
        const km = (kmOut != null && kmRet != null) ? Math.round(kmOut + kmRet) : null;
        if (km != null) {
          if (minKm == null || km < minKm) minKm = km;
          if (arv === origin && (homeKm == null || km < homeKm)) homeKm = km;
        }

        // ★このアプリで利用者に増えるのは「滞在する都市」だけ。
        // 途中降機で増える場合と、帰着地を変えて増える場合があり、
        // この2つは**別の軸ではなく同じ軸**（どちらも「もう1都市」）。
        // 掛け合わせるとパリ行きだけで560本になり選べなくなった（2026-09-06 実測）。
        // 出発地・目的地は元から行く場所なので「増える都市」に数えない。
        const already = new Set([origin, destination, retFrom]);
        const extras = [...new Set([soIata, arv].filter((x) => x && !already.has(x)))];
        if (extras.length > (req.maxExtraCities ?? 1)) continue;
        const extra = extras[0] ?? null;

        const key = `${m.miles}|${extra ?? '-'}`;
        const cand = {
          itinerary,
          miles: m.miles,
          milesNote: m.miles == null ? m.reason : m.note,
          milesBreakdown: m.breakdown ?? null,
          transits: op.length + rp.length,
          km,
          arrival: arv,
          arrivalName: cityName(arv),
          openJaw: arv !== origin,
          extraCity: extra,
          extraCityName: extra ? cityName(extra) : null,
          // 増える都市に「どうやって」立ち寄るか：途中降機か、帰着地にするか
          extraVia: extra == null ? null : (extra === soIata ? 'stopover' : 'arrival'),
          stopover: soIata,
          stopoverName: soIata ? cityName(soIata) : null,
          route: [
            [origin, ...op, destination].map(cityName).join(' → '),
            [retFrom, ...rp, arv].map(cityName).join(' → '),
          ],
          warnings: res.checks.filter((c) => c.ok === 'warn').map((c) => c.msg),
          variants: 1,
        };

        const cur = keep.get(key);
        if (!cur) { keep.set(key, cand); continue; }
        cur.variants++;
        // 代表は「総飛行距離がいちばん短い＝いちばん遠回りでない」もの
        const better =
          (cand.km ?? Infinity) !== (cur.km ?? Infinity) ? (cand.km ?? Infinity) < (cur.km ?? Infinity)
          : cand.transits !== cur.transits ? cand.transits < cur.transits
          : ovsCountOf(cand.itinerary) < ovsCountOf(cur.itinerary);
        if (better) { cand.variants = cur.variants; keep.set(key, cand); }
      }
    }
   }
  }

  // 寄り道先の「大手空港かどうか」「どの国か」を添える。
  // 魅力のあるルートを上に出すために使う（データは data/airports.json）
  const airports = ctx.airports ?? null;
  for (const p of keep.values()) {
    const a = p.extraCity && airports ? airports[p.extraCity] : null;
    p.stopoverSize = a?.size ?? null;
    p.stopoverCountry = a?.country ?? null;
    p.hubRoutes = p.extraCity ? hubScore(graph, p.extraCity, allowed) : null;
  }

  const proposals = [...keep.values()];
  stats.raw = proposals.reduce((a, p) => a + p.variants, 0);

  // 「遠回り」を測る。基準は合格した中でいちばん短く飛べる案。
  // 必要マイルは寄り道先が変わっても同じことが多いので、
  // **距離こそが「しんどさ」の唯一の手がかり**になる
  const baseKm = homeKm ?? minKm;
  stats.baseKm = baseKm;
  proposals.forEach((p) => {
    p.detourKm = (p.km != null && baseKm != null) ? p.km - baseKm : null;
    // 「まっすぐ帰る旅程」と比べて何km多く飛ぶか。
    // 帰着地を変えた案は総飛行距離がむしろ短くなることがある（負の値）。
    // そのときも 0 に丸めず、そのまま出す
    p.effort = p.detourKm == null ? null
      : p.detourKm <= 2000 ? 'ほぼ通り道'
      : p.detourKm <= 6000 ? '少し遠回り'
      : '大回り';
  });

  proposals.sort((a, b) => {
    if ((a.miles == null) !== (b.miles == null)) return a.miles == null ? 1 : -1;
    if (a.miles !== b.miles) return (a.miles ?? 0) - (b.miles ?? 0);
    // マイルが同じなら、遠回りの少ない順。ここが「しんどい案を下げる」中心
    if ((a.detourKm ?? 0) !== (b.detourKm ?? 0)) return (a.detourKm ?? 0) - (b.detourKm ?? 0);
    if (a.transits !== b.transits) return a.transits - b.transits;
    // 同条件なら就航路線の多い都市を上に（便が取りやすく、街としても大きい）
    if ((b.hubRoutes ?? 0) !== (a.hubRoutes ?? 0)) return (b.hubRoutes ?? 0) - (a.hubRoutes ?? 0);
    return ovsCountOf(a.itinerary) - ovsCountOf(b.itinerary);
  });

  stats.shown = proposals.length;
  return { proposals, stats };
}

// =====================================================================
// dedupeByExperience — 「利用者にとって違う旅」だけを残す（外から呼ぶ用）
// =====================================================================
// propose() は同じ畳み方をしながら進むので、通常はこの関数を呼ばなくてよい。
// 規約に適合する組み合わせをそのまま出すと、広島→パリで 42万本になる。
// 件数は多くても、その大半は**利用者にとって同じ旅**である。
//
// 残す軸は2つだけ：**必要マイル**と**寄り道（途中降機）先**。
// 乗り継ぎ地は、そこで飛行機を乗り換えるだけで街には出ないため、
// 羽田で乗り継ごうがフランクフルトで乗り継ごうが利用者の旅は変わらない。
// 「フランクフルトを見たい」は乗り継ぎではなく**寄り道**として現れる。
//
// まとめた本数は variants に残す（「他に何通りの組み方があるか」は
// 実際に予約するとき＝空席が取れないときの逃げ道になるため捨てない）。
// 代表として残すのは、並び替え済みの先頭＝乗り継ぎがいちばん少ない組み方。
// =====================================================================
export function dedupeByExperience(proposals, cities) {
  const keyOf = (p) => `${p.miles}|${p.stopover ?? '-'}`;
  const byKey = new Map();
  for (const p of proposals) {          // 並び順は保たれているので先頭が代表
    const k = keyOf(p);
    const cur = byKey.get(k);
    if (cur) { cur.variants++; continue; }
    byKey.set(k, { ...p, variants: 1 });
  }
  return [...byKey.values()];
}
