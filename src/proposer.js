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

// =====================================================================
// buildGraph — routes.json から「乗り継ぎに使える区間」だけの隣接表を作る
// =====================================================================
// 特典航空券で乗れるのは ANA と提携航空会社の便だけなので、
// 全58,089区間のうち対象社が運航する区間に絞る。
// さらに都市マスタ（CITIES）に無い空港は、ゾーンが分からず規約判定に
// かけられないため落とす。
// =====================================================================
export function buildGraph(routesJson, cities, opts = {}) {
  const carriers = opts.carriers;         // Set<string>（例: STAR_ALLIANCE）
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
function enumeratePaths(adj, cities, from, to, limits, cap, pruneRank) {
  const cityOf = new Map(cities.map((c) => [c.iata, c]));
  const out = [];

  const walk = (cur, visited, conns, domCnt, ovsCnt) => {
    if (out.length >= cap) return;
    const nexts = adj.get(cur);
    if (!nexts) return;
    if (nexts.has(to)) out.push([...conns]);          // ここから目的地へ直行できる
    if (conns.length >= limits.maxTransits) return;

    for (const nx of nexts.keys()) {
      if (out.length >= cap) return;
      if (nx === to || visited.has(nx)) continue;
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

  // 枝刈りの基準は旅程の目的地（オープンジョーなら両端の高いほう）。
  // 往路・復路のどちらも同じ基準を使う
  const rankOf = (iata) => ZONE_RANK[cities.find((c) => c.iata === iata)?.zone] ?? 0;
  const pruneRank = Math.max(rankOf(destination), rankOf(retFrom));

  const outPaths = enumeratePaths(graph.adj, cities, origin,  destination, limits, cap, pruneRank);
  const retPaths = enumeratePaths(graph.adj, cities, retFrom, arrival,     limits, cap, pruneRank);

  const stats = {
    outPaths: outPaths.length, retPaths: retPaths.length,
    combinations: 0, validated: 0, passed: 0, milesUnknown: 0,
    truncated: outPaths.length >= cap || retPaths.length >= cap,
  };

  const cityName = (iata) => cities.find((c) => c.iata === iata)?.name ?? iata;
  const typeOfCity = new Map(cities.map((c) => [c.iata, c.type]));
  const seen = new Set();
  const proposals = [];

  for (const op of outPaths) {
    for (const rp of retPaths) {
      stats.combinations++;
      // 寄り道の置き場所：置かない案＋各乗り継ぎ地に1つ置いた案
      const soPlacements = [null];
      if (req.wantStopover) {
        op.forEach((_, i) => soPlacements.push({ leg: 'out', idx: i }));
        rp.forEach((_, i) => soPlacements.push({ leg: 'ret', idx: i }));
      }

      for (const so of soPlacements) {
        const itinerary = {
          departure: origin,
          destination,
          arrival: arrival === origin ? null : arrival,
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
        const route = [
          [origin, ...op, destination].map(cityName).join(' → '),
          [retFrom, ...rp, arrival].map(cityName).join(' → '),
        ];
        // 同じ経路＋同じ寄り道の案は1つだけにする
        const key = `${op.join('>')}|${rp.join('>')}|${soIata ?? ''}`;
        if (seen.has(key)) continue;
        seen.add(key);

        proposals.push({
          itinerary,
          miles: m.miles,
          milesNote: m.miles == null ? m.reason : m.note,
          milesBreakdown: m.breakdown ?? null,
          transits: op.length + rp.length,
          stopover: soIata,
          stopoverName: soIata ? cityName(soIata) : null,
          route,
          warnings: res.checks.filter((c) => c.ok === 'warn').map((c) => c.msg),
        });
      }
    }
  }

  // 必要マイルの少ない順 → 乗り継ぎの少ない順。マイル不明は末尾へ
  // 同点のときは海外の乗り継ぎが少ないほうを代表にする。
  // 数が同じでも「パリ→シンガポール→札幌→広島」より
  // 「パリ→東京→札幌→広島」のほうが提案として素直なため
  const ovsCount = (p) => [...p.itinerary.outbound, ...p.itinerary.return]
    .filter(Boolean).filter((i) => typeOfCity.get(i) === 'overseas').length;
  proposals.sort((a, b) => {
    if ((a.miles == null) !== (b.miles == null)) return a.miles == null ? 1 : -1;
    if (a.miles !== b.miles) return (a.miles ?? 0) - (b.miles ?? 0);
    if (a.transits !== b.transits) return a.transits - b.transits;
    return ovsCount(a) - ovsCount(b);
  });

  stats.raw = proposals.length;
  const view = req.dedupe === 'none' ? proposals : dedupeByExperience(proposals, cities);
  stats.shown = view.length;
  return { proposals: view, stats };
}

// =====================================================================
// dedupeByExperience — 「利用者にとって違う旅」だけを残す
// =====================================================================
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
