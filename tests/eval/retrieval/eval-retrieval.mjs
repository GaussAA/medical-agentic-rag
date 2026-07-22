/**
 * 检索召回评测脚本
 * 独立评估 retrieve 编排工具的路由准确率、召回率、KG 覆盖率。
 *
 * 用法: node tests/eval/retrieval/eval-retrieval.mjs
 * 输出: 控制台报告 + tests/eval/retrieval/report.json
 *
 * 依赖: 项目根目录运行（需要 .pi/extensions/lib/ 下的模块）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

// ── 加载 retriever 内部模块（与 retrieve 工具逻辑相同）──
const guideRouter = await import(
  "file:///" + join(ROOT, ".pi", "extensions", "lib", "guide-router.mjs").replace(/\\/g, "/")
);
const kgSearch = await import(
  "file:///" + join(ROOT, ".pi", "extensions", "lib", "kg-search.mjs").replace(/\\/g, "/")
);

const { routeGuides, loadIndex } = guideRouter;
const { searchKG } = kgSearch;

// ── 加载评测集 ──
const goldPath = join(__dirname, "gold.json");
const gold = JSON.parse(readFileSync(goldPath, "utf-8"));

console.log(`\n═══ 检索召回评测 ═══\n`);
console.log(`评测集: ${gold.length} 条黄金标准\n`);

// ── 评测指标 ──
const results = [];

for (const g of gold) {
  const t0 = performance.now();

  // 1. 路由准确率
  let routeHit = false;
  let routeTop3 = false;
  let routeScore = 0;
  try {
    const index = loadIndex();
    const routeResult = routeGuides(g.query, { index, topK: 5 });
    const topGuides = (routeResult.top || []).map((r) => r.title);
    routeScore = routeResult.topScore || 0;

    // exact match
    routeHit = topGuides.length > 0 && topGuides[0].includes(g.expectedGuide.replace(/\.pdf$/, ""));
    // top-3 contains
    routeTop3 = topGuides.slice(0, 3).some((t) =>
      t.includes(g.expectedGuide.replace(/\.pdf$/, ""))
    );
  } catch (e) {
    console.error(`  [${g.id}] 路由失败:`, e.message);
  }

  // 2. 知识图谱覆盖率
  let kgSymptomHit = false;
  let kgDrugHit = false;
  let kgExamHit = false;
  let kgAllHit = false;
  if (g.expectedDisease) {
    try {
      const kgResult = searchKG({ disease: g.expectedDisease }, { useCache: true });
      if (kgResult.count > 0) {
        const entities = [];
        const lines = (kgResult.text || "").split("\n");
        for (const line of lines) {
          if (line.match(/^\s*症状:/)) entities.push("symptom");
          if (line.match(/^\s*药物:/)) entities.push("drug");
          if (line.match(/^\s*检查:/)) entities.push("examination");
          if (line.match(/^\s*危险因素:/)) entities.push("riskFactor");
          if (line.match(/^\s*治疗:/)) entities.push("treatment");
        }
        const uniqueTypes = new Set(entities);
        kgSymptomHit = !g.expectedEntityTypes.includes("symptom") || uniqueTypes.has("symptom");
        kgDrugHit = !g.expectedEntityTypes.includes("drug") || uniqueTypes.has("drug");
        kgExamHit = !g.expectedEntityTypes.includes("examination") || uniqueTypes.has("examination");
        kgAllHit = g.expectedEntityTypes.every((t) => uniqueTypes.has(t));
      }
    } catch {
      /* KG 降级 */
    }
  } else {
    kgSymptomHit = true;
    kgDrugHit = true;
    kgExamHit = true;
    kgAllHit = true;
  }

  const ms = (performance.now() - t0).toFixed(0);

  results.push({
    id: g.id,
    query: g.query,
    expectedGuide: g.expectedGuide,
    routeHit,
    routeTop3,
    routeScore,
    kgAllHit,
    kgSymptomHit,
    kgDrugHit,
    kgExamHit,
    ms: parseInt(ms),
  });

  const icon = routeHit ? "✅" : routeTop3 ? "⚠️" : "❌";
  const kgIcon = kgAllHit ? "✅" : "⚠️";
  console.log(`  ${icon} ${g.id}: ${g.query.slice(0, 30)}...`);
  console.log(`     路由: ${routeHit ? "Top1命中" : routeTop3 ? "Top3命中" : "未命中"} (score=${routeScore})`);
  console.log(`     KG: ${kgIcon} (期望实体: ${g.expectedEntityTypes.join("/")})`);
  console.log(`     耗时: ${ms}ms`);
}

// ── 汇总 ──
const routeHits = results.filter((r) => r.routeHit).length;
const routeTop3 = results.filter((r) => r.routeTop3).length;
const kgAllHits = results.filter((r) => r.kgAllHit).length;

const summary = {
  date: new Date().toISOString(),
  total: gold.length,
  // 路由指标
  routeTop1Accuracy: routeHits / gold.length,
  routeTop3Accuracy: routeTop3 / gold.length,
  // KG 指标
  kgCoverage: kgAllHits / gold.length,
  // 阈值（CI 门禁用）
  thresholds: {
    routeTop1Min: 0.85,
    kgCoverageMin: 0.85,
  },
  passed: routeHits / gold.length >= 0.85 && kgAllHits / gold.length >= 0.85,
  // 聚合
  averageMs: results.reduce((s, r) => s + r.ms, 0) / results.length,
  // 详情
  results,
};

console.log(`\n─── 汇总 ───`);
console.log(`路由 Top1 准确率: ${(summary.routeTop1Accuracy * 100).toFixed(1)}% (${routeHits}/${gold.length})`);
console.log(`路由 Top3 准确率: ${(summary.routeTop3Accuracy * 100).toFixed(1)}% (${routeTop3}/${gold.length})`);
console.log(`KG 实体覆盖率:    ${(summary.kgCoverage * 100).toFixed(1)}% (${kgAllHits}/${gold.length})`);
console.log(`平均耗时:         ${summary.averageMs.toFixed(0)}ms`);

// ├─ 写出报告
const reportPath = join(__dirname, "report.json");
writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf-8");
console.log(`\n报告已写入: ${reportPath}`);

// ── CI 门禁阈值检查 ──
const ROUTE_TOP1_MIN = 0.85; // 路由 Top1 ≥ 85%
const KG_COVERAGE_MIN = 0.85; // KG 覆盖率 ≥ 85%

const routeTop1Ok = summary.routeTop1Accuracy >= ROUTE_TOP1_MIN;
const kgCoverageOk = summary.kgCoverage >= KG_COVERAGE_MIN;

console.log(`\n─── 门禁阈值 ───`);
console.log(`路由 Top1 ≥ ${(ROUTE_TOP1_MIN * 100).toFixed(0)}%: ${routeTop1Ok ? "✅ 通过" : "❌ 未达标"} (${(summary.routeTop1Accuracy * 100).toFixed(1)}%)`);
console.log(`KG 覆盖率 ≥ ${(KG_COVERAGE_MIN * 100).toFixed(0)}%: ${kgCoverageOk ? "✅ 通过" : "❌ 未达标"} (${(summary.kgCoverage * 100).toFixed(1)}%)`);

if (!routeTop1Ok || !kgCoverageOk) {
  console.error("\n❌ 检索召回评测未通过 CI 门禁阈值");
  process.exit(1);
}
