// 独立引用召回核验：复刻 answer-quality-judge.mjs 的离线路由口径（不含 LLM-Judge）。
// 用于快速验证「router top3 病种匹配 gtSource 病种」的召回率，无需跑脆弱的完整评测。
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { routeGuides, loadIndex, normalize } from "../../.pi/extensions/lib/guide-router.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const index = loadIndex(REPO_ROOT);

function resolveGtDisease(gt) {
  if (!gt) return null;
  if (index.guideMap && index.guideMap[gt]) return index.guideMap[gt].disease || null;
  const n = normalize(gt);
  for (const d of DISEASE_VOCAB) {
    if (n.includes(normalize(d))) return d;
  }
  return null;
}

const DISEASE_VOCAB = (() => {
  const set = new Set();
  const gm = index.guideMap || {};
  for (const k of Object.keys(gm)) {
    if (gm[k].disease) set.add(gm[k].disease);
    if (gm[k].normalizedDisease) set.add(gm[k].normalizedDisease);
  }
  return [...set].filter((d) => d && d.length >= 2).sort((a, b) => b.length - a.length);
})();

const GOLD = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "gold-answers.json"), "utf-8"));
const ITEMS = GOLD.items || GOLD;

let citHit = 0, citTot = 0;
const rows = [];
for (const it of ITEMS) {
  const q = it.q || it.question || "";
  const gtSources = it.gtSources || (it.gtSource ? [it.gtSource] : []);
  const route = routeGuides(q, { index, useCache: false });
  const top3Diseases = route.top.slice(0, 3).map((g) => g.disease).filter(Boolean);
  const gtHit = gtSources.filter((g) => {
    const d = resolveGtDisease(g);
    return d && top3Diseases.includes(d);
  }).length;
  citHit += gtHit;
  citTot += gtSources.length;
  if (gtHit < gtSources.length) {
    rows.push({
      id: it.id,
      q: q.slice(0, 24),
      gt: gtSources.join("/"),
      gtDisease: gtSources.map((g) => resolveGtDisease(g)).join("/"),
      top3: route.top.slice(0, 3).map((g) => `${g.title}:${g.disease}`),
    });
  }
}

const pct = (h, t) => (t ? ((h / t) * 100).toFixed(1) : "—");
console.log(`\n引用召回率: ${pct(citHit, citTot)}%  (${citHit}/${citTot})`);
console.log(`\n=== 未命中 (${rows.length}) ===`);
for (const r of rows) {
  console.log(`\n[${r.id}] ${r.q}`);
  console.log(`  gtSource=${r.gt} -> disease=${r.gtDisease}`);
  console.log(`  top3=${JSON.stringify(r.top3, null, 0)}`);
}
