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
function enumeratePaths(adj, cities, from, to, limits, cap, pruneRank, allowed, domesticAnaOnly) {
  const cityOf = new Map(cities.map((c) => [c.iata, c]));
  const out = [];
  // その特典で乗れる社が1社も飛んでいない区間は、そもそも経路に使えない。
  // ★ANA国際線特典（自社便）は NH 運航便しか使えない。ここを見落とすと
  //   「羽田→グアム（UAのみ運航）」をANA自社便の提案として出してしまう
  //   （2026-09-06 に実際に28本中4本で発生していた）
  const usable = (from2, to2) => {
    const air = adj.get(from2)?.get(to2);
    if (!air) return false;
    // 2026年5月19日搭乗分より、日本国内線への乗り継ぎはANA運航便のみ。
    // 提携社のコードシェア便は使えない（data/award-rules.json に原文つきで記録）
    if (domesticAnaOnly &&
        cityOf.get(from2)?.type === 'domestic' && cityOf.get(to2)?.type === 'domestic' &&
        !air.includes('NH')) return false;
    return !allowed || air.some((a) => allowed.has(a));
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

// =====================================================================
// carrierPlans — 1つの旅程の中で組み合わせてよい社のまとまり
// =====================================================================
// 提携航空会社特典には**2つの形**があり、混ぜられない（規約の原文）：
//   「スターアライアンス加盟航空会社運航便とスター アライアンス コネクティング
//     パートナーであれば、各航空会社を自由に組み合わせた旅程もご利用になれます。」
//   「単一の提携航空会社運航便での旅程のみご利用になれます。」（非加盟の提携社）
//
// つまり non-alliance の提携社（EN/NX/EY/EW/OA/PR/VS/VN/VA）は
// **その1社だけで旅程を組む場合にしか使えない**。
// 2026-09-06 にこれを見落とし、スタアラ便とベトナム航空便を混ぜた提案を
// 114本出していた。旅程ごとに1つの plan を選び、その中だけで経路を作る。
// =====================================================================
// plan の表示名。画面に「どの特典で・どの航空会社のまとまりで飛ぶ旅程か」を出す
export function planLabel(planId, airlines) {
  if (planId === 'ana') return 'ANA国際線特典（ANA運航便のみ）';
  if (planId === 'star') return '提携特典・スターアライアンス（加盟社を自由に組み合わせ）';
  if (planId.startsWith('single:')) {
    const code = planId.slice(7);
    const name = airlines?.names?.[code];
    return `提携特典・${name ? name + '（' + code + '）' : code} 1社のみ`;
  }
  return planId;
}

export function carrierPlans(awardType, airlines) {
  if (!airlines) return [{ id: 'any', carriers: null }];
  if (awardType === 'ana') {
    return [{ id: 'ana', carriers: new Set(airlines.ana_own ?? ['NH']) }];
  }
  const plans = [{ id: 'star', carriers: new Set(airlines.star_alliance ?? []) }];
  for (const a of airlines.ana_partners ?? []) {
    if ((airlines.star_alliance ?? []).includes(a)) continue;  // 加盟社なら star 側で扱う
    plans.push({ id: `single:${a}`, carriers: new Set([a]) });
  }
  return plans;
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

const legPairs = (seq) => seq.slice(0, -1).map((a, i) => [a, seq[i + 1]]);

// 「自宅で途中降機して、国内線1区間を別の日に飛ぶ」形かどうか。
// 成立するのは、自宅での24時間超の滞在が**国内線1区間と隣り合っている**ときだけ：
//   復路版 … パリ → 東京（羽田）［途中降機］→ 那覇   ＝ 帰ってから、あとで那覇へ
//   往路版 … 那覇 → 東京（羽田）［途中降機］→ パリ   ＝ 先に那覇から来ておく
// 途中降機は往路・復路のどちらに置いてもよい（ANA公式・現行版で確認済み）。
// 自宅で降りても次が最終区間でなければ、切り離せる国内線1区間にならないので数えない。
function homeStopover(itinerary, home, cityKey) {
  const same = (iata) => iata != null && cityKey(iata) === cityKey(home);
  const op = itinerary.outbound.filter(Boolean);
  const rp = itinerary.return.filter(Boolean);
  if (rp.length && same(rp[rp.length - 1]) && itinerary.returnSO[rp.length - 1]) return 'ret';
  if (op.length && same(op[0]) && itinerary.outboundSO[0]) return 'out';
  return null;
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

  // 1つの旅程の中で組み合わせてよい社のまとまり。
  // 提携特典は「スタアラを自由に混ぜる」か「非加盟の提携社1社だけ」の二択で、
  // 両者を混ぜられない。plan ごとに別々に経路を作り、最後に束ねる
  const plans = carrierPlans(awardType, ctx.airlines);
  const allowed = allowedCarriers(awardType, ctx.airlines);   // 表示・集計用

  // 2026年5月19日搭乗分より、日本国内線への乗り継ぎはANA運航便のみ
  const domesticAnaOnly = (rules.common?.japanDomesticAnaOnly ?? true)
    && (req.asOf ?? '2026-09-07') >= '2026-05-19';

  // 枝刈りの基準は旅程の目的地（オープンジョーなら両端の高いほう）。
  // 往路・復路のどちらも同じ基準を使う
  const rankOf = (iata) => ZONE_RANK[cities.find((c) => c.iata === iata)?.zone] ?? 0;
  const pruneRank = Math.max(rankOf(destination), rankOf(retFrom));
  const coords = ctx.coords ?? null;

  const stats = {
    outPathsFound: 0, retPathsFound: 0, outPaths: 0, retPaths: 0,
    combinations: 0, validated: 0, passed: 0, milesUnknown: 0,
    // 規約は通ったが「ANA便でしか飛べない＋日本発の途中降機」で発券できない案の数。
    // 黙って捨てると、あとで件数が合わない理由が誰にも分からなくなる
    droppedAnaOnly: 0,
    truncated: false, carriers: allowed ? allowed.size : null,
    plans: plans.map((p) => p.id), plansUsed: [],
  };

  // plan ごとに「往路の経路」「帰着地ごとの復路の経路」を作る
  const routeSets = [];
  for (const plan of plans) {
    const ac = plan.carriers;
    const allOut = enumeratePaths(graph.adj, cities, origin, destination, limits, cap, pruneRank, ac, domesticAnaOnly);
    if (!allOut.length) continue;
    const allRet = enumeratePaths(graph.adj, cities, retFrom, arrival, limits, cap, pruneRank, ac, domesticAnaOnly);
    if (!allRet.length) continue;

    const repOut = pickRepresentativePaths(allOut, origin, destination, coords);
    const repRet = pickRepresentativePaths(allRet, retFrom, arrival, coords);
    stats.outPathsFound += repOut.enumerated; stats.retPathsFound += repRet.enumerated;
    stats.outPaths += repOut.paths.length;    stats.retPaths += repRet.paths.length;
    stats.truncated = stats.truncated || allOut.length >= cap || allRet.length >= cap;
    stats.plansUsed.push(plan.id);

    // 帰着地を出発地と変える案（国内オープンジョー）も既定で混ぜる。
    // 「羽田発 → パリ → 沖縄着」のように、国内枠を使ってもう1都市に降りる形。
    // ★海外オープンジョー（復路の出発地を目的地と変える）はやらない（ユーザー決定）
    const retSets = [{ arrival, paths: repRet.paths }];
    if (req.domesticOpenJaw !== false && arrival === origin) {
      for (const c of cities) {
        if (c.type !== 'domestic' || c.iata === origin) continue;
        // 帰着地は就航路線が多い空港だけ。就航先が少ない空港へ降ろしても
        // 実際には便が取れず提案として役に立たない
        if (hubScore(graph, c.iata, ac) < (req.minHubRoutes ?? 8)) continue;
        const alt = enumeratePaths(graph.adj, cities, retFrom, c.iata, limits, cap, pruneRank, ac, domesticAnaOnly);
        if (!alt.length) continue;
        const rep = pickRepresentativePaths(alt, retFrom, c.iata, coords);
        retSets.push({ arrival: c.iata, paths: rep.paths });
      }
    }
    // 出発地を自宅と変える案（往路側の国内オープンジョー）。
    // 「那覇 → 東京（羽田）［24時間以上とまる］ → パリ … → 東京（羽田）」のように、
    // **自宅で途中降機して、国内線1区間を国際線とは別の日に飛ぶ**形。
    // 途中降機は往路・復路のどちらに置いてもよい（ANA公式・現行版の例示で確認）ので、
    // 復路側（パリ → 羽田［途中降機］→ 那覇）だけを見ていると半分を取り逃がす。
    const outSets = [{ departure: origin, paths: repOut.paths }];
    if (req.domesticOpenJaw !== false && arrival === origin) {
      for (const c of cities) {
        if (c.type !== 'domestic' || c.iata === origin) continue;
        if (hubScore(graph, c.iata, ac) < (req.minHubRoutes ?? 8)) continue;
        const alt = enumeratePaths(graph.adj, cities, c.iata, destination, limits, cap, pruneRank, ac, domesticAnaOnly);
        // 自宅がいちばん最初の経由地になる形だけを採る。
        // そうでないと「切り離して後から飛べる国内線1区間」にならない
        const viaHome = alt.filter((pth) => pth[0] === origin);
        if (!viaHome.length) continue;
        const rep = pickRepresentativePaths(viaHome, c.iata, destination, coords);
        outSets.push({ departure: c.iata, paths: rep.paths });
      }
    }
    routeSets.push({ plan: plan.id, carriers: ac, outSets, retSets });
  }

  const cityName = (iata) => cities.find((c) => c.iata === iata)?.name ?? iata;
  const typeOfCity = new Map(cities.map((c) => [c.iata, c.type]));

  // 同じ街の別空港（羽田と成田、関空と伊丹と神戸）は「もう1都市」に数えない。
  // 羽田発の旅程で成田に降りても、増えるのは都市ではなく空港でしかない
  const sameCity = new Map();
  cities.forEach((c) => (c.group ?? []).forEach((m) => sameCity.set(m, c.iata)));
  const cityKey = (iata) => sameCity.get(iata) ?? iata;
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

  for (const rs of routeSets) {
   for (const os of rs.outSets) {
    for (const op of os.paths) {
    for (const { arrival: arv, paths: rps } of rs.retSets) {
     // 出発地と帰着地の両方を自宅と変える形は作らない（国内オープンジョーは片側だけ）
     if (os.departure !== origin && arv !== origin) continue;
     for (const rp of rps) {
      stats.combinations++;
      const soPlacements = [null];
      if (req.wantStopover) {
        op.forEach((_, i) => soPlacements.push({ leg: 'out', idx: i }));
        rp.forEach((_, i) => soPlacements.push({ leg: 'ret', idx: i }));
      }

      for (const so of soPlacements) {
        const itinerary = {
          departure: os.departure,
          destination,
          arrival: arv === os.departure ? null : arv,
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
        const kmOut = coords ? pathDistanceKm([os.departure, ...op, destination], coords) : null;
        const kmRet = coords ? pathDistanceKm([retFrom, ...rp, arv], coords) : null;
        const km = (kmOut != null && kmRet != null) ? Math.round(kmOut + kmRet) : null;
        if (km != null) {
          if (minKm == null || km < minKm) minKm = km;
          // 基準＝自宅を出て自宅に帰る旅程の最短。ここから何km多く飛ぶかで並べる
          if (arv === origin && os.departure === origin && (homeKm == null || km < homeKm)) homeKm = km;
        }

        // ★このアプリで利用者に増えるのは「滞在する都市」だけ。
        // 途中降機で増える場合と、帰着地を変えて増える場合があり、
        // この2つは**別の軸ではなく同じ軸**（どちらも「もう1都市」）。
        // 掛け合わせるとパリ行きだけで560本になり選べなくなった（2026-09-06 実測）。
        // 出発地・目的地は元から行く場所なので「増える都市」に数えない。
        // 自宅・目的地・復路の出発地は「元から行く場所」なので増える都市に数えない。
        // ★基準は origin（利用者の自宅）であって os.departure（切符の出発地）ではない。
        //   往路側の自宅途中降機では、切符の出発地こそが「増える都市」になる。
        // ★利用者が自分で指定した帰着地・復路出発地も「元から行く場所」に含める。
        //   指定した街は提案ではなく前提なので、これを1都市に数えると
        //   「福岡発 → リスボン → 羽田着」で寄り道が1つも出せなくなる（2026-09-08 是正）
        const already = new Set([origin, destination, retFrom, req.arrival, req.returnDep]
          .filter(Boolean).map(cityKey));
        const extras = [...new Map(
          [soIata, arv, os.departure].filter(Boolean)
            .filter((x) => !already.has(cityKey(x)))
            .map((x) => [cityKey(x), x])
        ).values()];
        if (extras.length > (req.maxExtraCities ?? 1)) continue;
        const extra = extras[0] ?? null;

        // 畳むときも街単位。関空と伊丹を別の「もう1都市」として2行出さない
        // 同じ都市でも「行き方」が違えば別の旅。代表を距離だけで選ぶと、
        // 遠回りになる 🏠（自宅で途中降機）が必ず負けて一覧から消える
        //（2026-09-07 に実際に起きていた。羽田→パリで 2,752 通りが埋もれていた）
        const homeLeg = homeStopover(itinerary, origin, cityKey);   // 'out' | 'ret' | null
        const viaKind = homeLeg ? 'home'
          : extra == null ? '-'
          : extra === soIata ? 'stopover' : 'arrival';
        // ★往路版（国内線を先に飛ぶ）と復路版（あとに飛ぶ）は別の旅。
        //   同じキーにすると距離の短いほうだけが残り、片方が消える
        const key = `${m.miles}|${extra ? cityKey(extra) : '-'}|${viaKind}${homeLeg ? ':' + homeLeg : ''}`;
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
          extraVia: viaKind === '-' ? null : viaKind,
          // 自宅での途中降機を往路・復路のどちらに置いたか。
          // 'out' ＝ 国内線を先に飛ぶ／'ret' ＝ 国内線をあとに飛ぶ
          homeLeg,
          // どの特典・どの航空会社のまとまりで飛ぶ旅程か
          awardType,
          plan: rs.plan,
          planLabel: planLabel(rs.plan, ctx.airlines),
          stopover: soIata,
          stopoverName: soIata ? cityName(soIata) : null,
          route: [
            [os.departure, ...op, destination].map(cityName).join(' → '),
            [retFrom, ...rp, arv].map(cityName).join(' → '),
          ],
          warnings: res.checks.filter((c) => c.ok === 'warn').map((c) => c.msg),
          // 区間ごとに「この旅程で実際に乗れる社」。画面で便を探すときに要る
          carriersByLeg: [
            ...legPairs([os.departure, ...op, destination]),
            ...legPairs([retFrom, ...rp, arv]),
          ].map(([a, b]) => ({
            from: a, to: b,
            airlines: (graph.adj.get(a)?.get(b) ?? [])
              .filter((x) => !rs.carriers || rs.carriers.has(x)),
          })),
          variants: 1,
        };

        // ★ANA便でしか飛べない旅程は「ANA国際線特典」として扱われる。
        // 提携（スタアラ）特典にするには、ANA以外の加盟社の便が1区間以上必要
        //（実務解説2件で一致。公式は製品名でしか書いていない）。
        // 日本発の途中降機はANA国際線特典では不可なので、この形は**どちらの特典でも成立しない**。
        // 代表を選ぶ前にここで落とす（後で落とすと、成立する別の組み方が埋もれる）
        if (awardType === 'partner') {
          const sole = soleCarrierOf(cand.carriersByLeg);
          if (sole === 'NH') {
            if (soIata) { stats.droppedAnaOnly++; continue; }   // ANA便のみ＋日本発の途中降機＝不成立
            cand.actualAward = 'ana';          // 途中降機が無ければ成立するが、扱いはANA国際線特典
            cand.awardNote = 'この旅程はANA便だけで組めるため、ANA国際線特典として扱われます（必要マイルはANAのチャート・シーズンで変わります）。';
            const anaMiles = requiredMiles(itinerary, {
              awardType: 'ana', charts, cities,
              cabin: req.cabin, season: req.season, revision: req.revision,
            });
            if (anaMiles.miles != null) {
              cand.miles = anaMiles.miles;
              cand.milesNote = anaMiles.note;
              cand.milesBreakdown = anaMiles.breakdown ?? null;
            }
          }
        }

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

// 実際に選べる運航会社が1社に絞られる旅程かどうか。
// 提案は「区間ごとに、その特典で乗れる社が1社以上いる」ことしか見ていない。
// だが全区間で選べるのがANAだけなら、実際に予約できるのはANA運航便だけの旅程で、
// そのときANA国際線特典の規約（日本発の途中降機は不可）が当たる可能性がある。
// 公式は提携特典の対象便に ANA(NH) を含めており（「各航空会社を自由に組み合わせた
// 旅程もご利用になれます」）、ANA便だけの旅程を提携特典として発券できるかは沈黙している。
// **沈黙している以上、成立すると言い切らない**（fail-safe は厳しい側へ・2026-09-06 決定）。
export function soleCarrierOf(carriersByLeg) {
  if (!Array.isArray(carriersByLeg) || carriersByLeg.length === 0) return null;
  const first = carriersByLeg[0]?.airlines ?? [];
  if (first.length !== 1) return null;
  const only = first[0];
  return carriersByLeg.every((l) => l.airlines.length === 1 && l.airlines[0] === only) ? only : null;
}

// 日本発の途中降機を含むか（ANA国際線特典では不可）
function hasJapanStopover(itinerary, cities) {
  const typeOf = new Map(cities.map((c) => [c.iata, c.type]));
  const dep = itinerary.departure;
  if (typeOf.get(dep) !== 'domestic') return false;      // 日本発の旅程だけが対象
  const so = [];
  itinerary.outbound.filter(Boolean).forEach((c, i) => { if (itinerary.outboundSO[i]) so.push(c); });
  itinerary.return.filter(Boolean).forEach((c, i) => { if (itinerary.returnSO[i]) so.push(c); });
  return so.length > 0;
}

// =====================================================================
// groupByCity — 画面に出す形（都市ごとに1行・行き方はその中）へ畳む
// =====================================================================
// propose() が返すのは「都市 × 行き方」の一覧。そのまま並べると同じ那覇が
// 離れた3か所に出るため、画面では**都市ごとに1行**にし、行き方（🛬 帰りに降りる／
// ✈️ 寄り道／🏠 自宅で途中降機）を行の中に並べる。
//
// 海外は**同じ国で1行**に畳む（フランクフルトとミュンヘンを別行にしない）。
// 国内は畳まない——福岡と那覇を「日本」にまとめると、帰着地を選ぶという
// 行為そのものが画面から消えるため（2026-09-07 ユーザー確認済み）。
//
// ctx = { airports }（国の判定に使う。無ければ畳まない）
// 戻り値 = [{ city, iata, country, miles, extra, hub, detour, effort,
//             sameCountry:[都市名], ways:[提案] }]
// =====================================================================
export function groupByCity(proposals, ctx = {}) {
  const airports = ctx.airports ?? null;
  const countryOf = (iata) => (airports && airports[iata]?.country) ?? null;
  const rows = new Map();
  for (const p of proposals) {
    if (p.extraCity == null) continue;
    const co = countryOf(p.extraCity);
    const key = (co && co !== 'JP') ? `${p.miles}|C:${co}` : `${p.miles}|A:${p.extraCity}`;
    if (!rows.has(key)) rows.set(key, []);
    rows.get(key).push(p);
  }
  return [...rows.values()].map((group) => {
    group.sort((a, b) => (a.detourKm ?? 0) - (b.detourKm ?? 0));
    const best = group[0];
    // 同じ行き方が複数あるときは、いちばん遠回りでないものを代表にする
    const ways = [];
    for (const w of group) {
      const kind = `${w.extraVia}${w.homeLeg ? ':' + w.homeLeg : ''}`;
      if (!ways.some((x) => `${x.extraVia}${x.homeLeg ? ':' + x.homeLeg : ''}` === kind)) ways.push(w);
    }
    return {
      city: best.extraCityName, iata: best.extraCity, country: countryOf(best.extraCity),
      miles: best.miles, hub: best.hubRoutes ?? 0,
      detour: best.detourKm ?? 0, effort: best.effort,
      sameCountry: [...new Set(group.map((g) => g.extraCityName))].filter((n) => n !== best.extraCityName),
      ways,
    };
  }).sort((a, b) => (a.miles - b.miles) || (a.detour - b.detour));
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

// =====================================================================
// evaluateItinerary — 1つの旅程を「3つの特典すべて」で判定する
// =====================================================================
// 自分で組んだ旅程が、ANA自社便／スターアライアンス／提携社1社の
// **どれで成立するか**を並べて出すためのもの。
// 規約が別物なので、片方で違反でも他方では成立することがある。
//
// 戻り値 = [{ id, label, awardType, ok, reasons[], checks[], carriersByLeg[] }]
//   ok=true  … その特典で成立する（規約も、乗れる社も、両方通る）
//   reasons  … 成立しない理由（規約違反 or 乗れる社がいない区間）
// =====================================================================
export function evaluateItinerary(itinerary, ctx) {
  const { rules, cities, graph, airlines } = ctx;
  const out = [];
  const seq = (arr, a, b) => [a, ...arr.filter(Boolean), b];
  const dep = itinerary.departure;
  const dest = itinerary.destination;
  const arr = itinerary.arrival ?? dep;
  const retFrom = itinerary.returnDep ?? dest;
  const domesticAnaOnly = (ctx.asOf ?? '2026-09-07') >= '2026-05-19';
  const typeOf = new Map(cities.map((c) => [c.iata, c.type]));

  for (const awardType of ['ana', 'partner']) {
    for (const plan of carrierPlans(awardType, airlines)) {
      const res = validateItinerary(itinerary, { awardType, rules, cities });
      const reasons = res.checks.filter((c) => c.ok === false).map((c) => c.msg);

      // 規約を通っても、その社のまとまりで飛べない区間があれば成立しない
      const legs = [...legPairs(seq(itinerary.outbound, dep, dest)),
                    ...legPairs(seq(itinerary.return, retFrom, arr))];
      const carriersByLeg = legs.map(([a, b]) => {
        const all = graph.adj.get(a)?.get(b) ?? [];
        const usable = all.filter((x) => !plan.carriers || plan.carriers.has(x));
        const domesticPair = typeOf.get(a) === 'domestic' && typeOf.get(b) === 'domestic';
        const anaOnlyBlocked = domesticAnaOnly && domesticPair && !all.includes('NH');
        return { from: a, to: b, airlines: usable, anaOnlyBlocked };
      });
      carriersByLeg.forEach((l) => {
        if (l.anaOnlyBlocked) {
          reasons.push(`[乗り継ぎ] ${l.from}→${l.to} は日本国内線で、ANA運航便がありません（2026-05-19 搭乗分〜の規定）`);
        } else if (l.airlines.length === 0) {
          reasons.push(`[運航] ${l.from}→${l.to} を飛ぶ対象航空会社がありません`);
        }
      });

      out.push({
        id: plan.id,
        label: planLabel(plan.id, airlines),
        awardType,
        ok: reasons.length === 0,
        reasons,
        checks: res.checks,
        carriersByLeg,
      });
    }
  }
  // 成立するものを先に、その中では選択肢の多いものを先に
  out.sort((a, b) => (b.ok - a.ok) || (b.carriersByLeg.flatMap((l) => l.airlines).length
                                     - a.carriersByLeg.flatMap((l) => l.airlines).length));
  return out;
}

// =====================================================================
// evaluateByKind — 「ANA自社便 / スターアライアンス / 提携航空会社」の3つで判定
// =====================================================================
// 画面に出すための形。提携社は9社あるが利用者にとっては1つの選択肢なので、
// 「どれか1社で成立するか」にまとめ、成立する社を並べる。
// =====================================================================
export function evaluateByKind(itinerary, ctx) {
  const all = evaluateItinerary(itinerary, ctx);
  const pick = (id) => all.find((r) => r.id === id);
  const singles = all.filter((r) => r.id.startsWith('single:'));
  const okSingles = singles.filter((r) => r.ok);
  const names = ctx.airlines?.names ?? {};

  const ana = pick('ana'), star = pick('star');
  return [
    {
      kind: 'ana',
      label: 'ANA国際線特典（ANA運航便のみ）',
      ok: !!ana?.ok,
      reasons: ana?.reasons ?? [],
      carriersByLeg: ana?.carriersByLeg ?? [],
    },
    {
      kind: 'star',
      label: '提携特典・スターアライアンス',
      note: '加盟社を自由に組み合わせられる',
      // ★スターアライアンス特典として発券するには、ANA以外の加盟社の便が
      //   1区間以上必要。ANA便だけの旅程はANA国際線特典として扱われるため、
      //   規約そのものを通っていてもスタアラ特典としては成立しない
      ok: !!star?.ok && soleCarrierOf(star?.carriersByLeg ?? []) !== 'NH',
      reasons: soleCarrierOf(star?.carriersByLeg ?? []) === 'NH'
        ? ['この旅程はANA便でしか飛べません。スターアライアンス特典にするには、ANA以外の加盟社の便が1区間以上必要です']
        : (star?.reasons ?? []),
      carriersByLeg: star?.carriersByLeg ?? [],
      anaOnly: soleCarrierOf(star?.carriersByLeg ?? []) === 'NH',
    },
    {
      kind: 'partner',
      label: '提携特典・提携航空会社',
      note: '★1社だけで組む旅程にしか使えない',
      ok: okSingles.length > 0,
      // 成立する社が無いときは、どの社でも落ちる理由をまとめて1つ出す
      reasons: okSingles.length > 0 ? []
        : ['この旅程を1社だけで飛べる提携航空会社がありません'],
      airlines: okSingles.map((r) => {
        const code = r.id.slice(7);
        return { code, name: names[code] ?? code };
      }),
      carriersByLeg: okSingles[0]?.carriersByLeg ?? [],
    },
  ];
}
