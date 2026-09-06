// テストと確認用CLIが共通で使う読み込み。
// 都市マスタ・スターアライアンス名簿は index.html を実際に読む
// （写経すると、アプリを直したときにテストだけ古いままになる）。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildAwardRules } from '../src/rules-core.js';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(ROOT, 'index.html'), 'utf8');

function extract(pattern, name) {
  const m = html.match(pattern);
  if (!m) throw new Error(`index.html から ${name} を取り出せません`);
  // eslint-disable-next-line no-new-func
  return new Function(`${m[0]}\nreturn ${name};`)();
}

export const CITIES        = extract(/const CITIES = \[[\s\S]*?\n\];/, 'CITIES');
export const STAR_ALLIANCE = extract(/const STAR_ALLIANCE = new Set\(\[[\s\S]*?\n\]\);/, 'STAR_ALLIANCE');

export const readJson = (rel) => JSON.parse(readFileSync(join(ROOT, rel), 'utf8'));
export const RULES_JSON = readJson('data/award-rules.json');
export const AIRLINES = readJson('data/airlines.json');
export const ALL_CARRIERS = new Set([
  ...AIRLINES.ana_own, ...AIRLINES.star_alliance, ...AIRLINES.ana_partners,
]);
export const CHARTS = {
  partner: readJson('data/mile-chart-partner.json'),
  ana:     readJson('data/mile-chart-ana.json'),
};
export const buildRules = (asOf = '2026-09-06') => buildAwardRules(RULES_JSON, { asOf });
export const loadRoutes = () => readJson('routes.json');
