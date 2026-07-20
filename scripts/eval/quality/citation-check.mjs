// 独立引用召回核验：复刻 answer-quality-judge.mjs 的离线路由口径（不含 LLM-Judge）。
// 用于快速验证「router top3 病种匹配 gtSource 病种」的召回率，无需跑脆弱的完整评测。
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync } from "node:fs";
import { routeGuides, loadIndex, normalize } from "../../../.pi/extensions/lib/guide-router.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const index = loadIndex(REPO_ROOT);

// P1#8 抽离：改为可导出纯函数，guideMap/vocab 默认取模块级索引，
// 单测可传合成索引，脱离真实 KB 依赖。
export function resolveGtDisease(gt, guideMap = index.guideMap, vocab = DISEASE_VOCAB) {
  if (!gt) return null;
  if (guideMap && guideMap[gt]) return guideMap[gt].disease || null;
  const n = normalize(gt);
  for (const d of vocab) {
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

// ---------- CLI 主流程（import 不触发，仅直接运行本文件时执行） ----------
function main() {
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
}

// 仅当本文件被直接运行时执行 CLI；被 import（如单测）时不触发，
// 使 resolveGtDisease 可零副作用地独立测试。
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
