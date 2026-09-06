// 提案の中身を目で確かめるための確認用CLI。
//   node tests/propose_cli.mjs HIJ CDG [--ana] [--stopover] [--top 10] [--biz]
// 計画の検証欄「候補を件数でなく1本ずつ目視して第1〜7条を人手で検算する」用。
import { CITIES, STAR_ALLIANCE, CHARTS, buildRules, loadRoutes } from './_load.mjs';
import { buildGraph, propose } from '../src/proposer.js';

const argv = process.argv.slice(2);
const flag = (n) => argv.includes(n);
const val  = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const pos  = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--top'));

const origin      = pos[0] ?? 'HIJ';
const destination = pos[1] ?? 'CDG';
const awardType   = flag('--ana') ? 'ana' : 'partner';
const cabin       = flag('--biz') ? 'biz' : 'eco';
const top         = Number(val('--top', 10));

const t0 = Date.now();
const rules = buildRules();
const graph = buildGraph(loadRoutes(), CITIES, { carriers: STAR_ALLIANCE });
const tGraph = Date.now() - t0;

const t1 = Date.now();
const { proposals, stats } = propose({
  origin, destination, awardType, cabin,
  returnDep: val('--openjaw', undefined),
  wantStopover: flag('--stopover'),
  maxTransits: Number(val('--max', 3)),
  dedupe: flag('--raw') ? 'none' : undefined,
}, { rules, charts: CHARTS, cities: CITIES, graph });
const tRun = Date.now() - t1;

const name = (i) => CITIES.find((c) => c.iata === i)?.name ?? i;
console.log(`\n■ ${name(origin)} → ${name(destination)}（${awardType} / ${cabin}${flag('--stopover') ? ' / 寄り道あり' : ''}）`);
console.log(`  路線グラフ: ${graph.stats.kept}区間・${graph.stats.nodes}空港（対象社が飛ばない区間 ${graph.stats.dropped} を除外）— ${tGraph}ms`);
console.log(`  経路列挙: 往路${stats.outPaths}通り × 復路${stats.retPaths}通り = ${stats.combinations}組`);
console.log(`  規約判定: ${stats.validated}件 → 合格 ${stats.passed}件 → 集約して ${stats.shown}本（合格の組み合わせ ${stats.raw}）` +
            `${stats.milesUnknown ? `（うちマイル不明 ${stats.milesUnknown}）` : ''}${stats.truncated ? ' ※列挙を打ち切りました' : ''} — ${tRun}ms\n`);

proposals.slice(0, top).forEach((p, i) => {
  console.log(`${String(i + 1).padStart(2)}. ${p.miles == null ? '（マイル不明）' : `${p.miles.toLocaleString()} マイル`}` +
              `  乗継${p.transits}回${p.stopover ? `  寄り道: ${p.stopoverName}` : '  （寄り道なし）'}` +
              `${p.variants > 1 ? `  ／同じ旅の組み方 ${p.variants.toLocaleString()} 通り` : ''}`);
  console.log(`    往路 ${p.route[0]}`);
  console.log(`    復路 ${p.route[1]}`);
  if (p.milesNote) console.log(`    ${p.milesNote}`);
  p.warnings.forEach((w) => console.log(`    ⚠️ ${w}`));
});
if (proposals.length > top) console.log(`\n… 他 ${proposals.length - top} 本`);
