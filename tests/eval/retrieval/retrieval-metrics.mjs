/**
 * 检索层元指标评测（Retrieval Quality Metrics）
 *
 * 在现有路由准确率 + KG 覆盖率基础上，新增：
 *   - Recall@K：Gold 文档在 Top-K 检索结果中的命中率
 *   - MRR（Mean Reciprocal Rank）：首个相关文档的排名倒数均值
 *   - NDCG@10：归一化折损累计增益
 *   - 空结果率：检索返回0条的比例
 *   - 检索多样性@5：Top-5 结果覆盖的指南数
 *
 * 输出: tests/reports/retrieval-metrics.json
 *       （与 eval-retrieval.mjs 的 report.json 格式保持一致，扩展指标）
 *
 * 用法:
 *   node tests/eval/retrieval/retrieval-metrics.mjs                  # 轻量模式(路由+KG+KB可用性)
 *   node tests/eval/retrieval/retrieval-metrics.mjs --full           # 全量模式(含实际检索)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");

const FULL_MODE = process.argv.includes("--full");

// ── 加载检索模块 ──
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

// ── 若全量模式，尝试加载 chunk 级检索 ──
let searchKnowledge = null;

if (FULL_MODE) {
  try {
    const router = await import(
      "file:///" + join(ROOT, ".pi", "extensions", "lib", "retrieval-router.mjs").replace(/\\/g, "/")
    );
    searchKnowledge = router.searchKnowledge;
  } catch (e) {
    console.warn("  ⚠️  chunk 级检索模块加载失败，回退路由级评测:", e.message);
  }
}

// ── 辅助函数 ──
const GUIDE_CACHE = new Map();

function normalizeGuideTitle(title) {
  if (!title) return "";
  return title
    .replace(/\.pdf$/i, "")
    .replace(/[（(].*版[）)]$/, "")  // 去掉 (2024年版) 后缀做模糊匹配
    .replace(/[（(]\d{4}年修订版[）)]$/, "")
    .replace(/[（(]\d{4}年版[）)]$/, "")
    .trim();
}

function fuzzyMatch(haystack, needle) {
  const h = normalizeGuideTitle(haystack);
  const n = normalizeGuideTitle(needle);
  if (!h || !n) return false;
  return h.includes(n) || n.includes(h);
}

/**
 * 判断检索结果列表是否包含期望指南。
 * 返回 { hit: boolean, rank: number|null }
 * rank 是从 1 开始的首次命中位置，未命中则 rank=null
 */
function findGuideInResults(results, expectedGuide) {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const title = r.title || r.file || r.file_path || "";
    if (fuzzyMatch(title, expectedGuide)) {
      return { hit: true, rank: i + 1 };
    }
  }
  return { hit: false, rank: null };
}

/**
 * 计算 NDCG@K
 * relevance: 每个位置的关联度数组（0/0.5/1）
 */
function ndcg(relevance, k) {
  const actual = relevance.slice(0, k);
  // DCG
  let dcg = 0;
  for (let i = 0; i < actual.length; i++) {
    dcg += actual[i] / Math.log2(i + 2); // log2(i+2) since i is 0-based
  }
  // IDCG：按 ideal 排序（降序）
  const ideal = [...actual].sort((a, b) => b - a);
  let idcg = 0;
  for (let i = 0; i < ideal.length; i++) {
    idcg += ideal[i] / Math.log2(i + 2);
  }
  return idcg > 0 ? dcg / idcg : 0;
}

// ── 主评测循环 ──
const perCaseResults = [];
let totalRetrievable = 0;
let totalZeroResult = 0;

for (const g of gold) {
  const t0 = performance.now();
  const caseResult = {
    id: g.id,
    query: g.query,
    expectedGuide: g.expectedGuide,
  };

  // 1. 路由准确率 (复用 eval-retrieval.mjs 口径)
  let routeHit = false;
  let routeTop3 = false;
  let routeScore = 0;
  let routeTopGuides = [];
  try {
    const index = loadIndex();
    const routeResult = routeGuides(g.query, { index, topK: 5 });
    routeTopGuides = (routeResult.top || []).map((r) => ({
      title: r.title,
      disease: r.disease,
      score: r.score,
    }));
    routeScore = routeResult.topScore || 0;
    routeHit = routeTopGuides.length > 0 && fuzzyMatch(routeTopGuides[0].title, g.expectedGuide);
    routeTop3 = routeTopGuides.slice(0, 3).some((r) => fuzzyMatch(r.title, g.expectedGuide));
  } catch (e) {
    console.error(`  [${g.id}] 路由失败:`, e.message);
  }
  caseResult.routeHit = routeHit;
  caseResult.routeTop3 = routeTop3;
  caseResult.routeScore = routeScore;
  caseResult.routeTopGuides = routeTopGuides;

  // 2. KG 覆盖率
  let kgAllHit = true;
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
        kgAllHit = g.expectedEntityTypes.every((t) => uniqueTypes.has(t));
      } else {
        kgAllHit = false;
      }
    } catch {
      kgAllHit = false;
    }
  }
  caseResult.kgAllHit = kgAllHit;

  // 3. 检索级指标（全量模式）
  let recallAt5 = false;
  let recallAt10 = false;
  let mrr = 0;
  let ndcg5 = 0;
  let ndcg10 = 0;
  let firstRank = null;
  let retrievedCount = 0;
  let uniqueSourceCount = 0;

  if (FULL_MODE && searchKnowledge) {
    try {
      // 模拟 retrieve 工具的检索管道
      const index = loadIndex();
      const routeResult = routeGuides(g.query, { index, topK: 5 });
      const topGuides = (routeResult.top || []).map((r) => r.title);
      const lowConfidence = !!routeResult.lowConfidence;

      // 调用 searchKnowledge（BM25 检索）
      const kbFilesAll = []; // 运行时动态获取
      let searchOpts = { limit: 20, useRouting: true, index };
      const result = searchKnowledge(g.query, searchOpts);
      retrievedCount = (result?.results || []).length;
      const chunkResults = result?.results || [];

      // 检测空结果
      if (retrievedCount === 0) {
        totalZeroResult++;
      }

      // 将 chunk 级结果按文件聚合（每个文件只计一次，存最高分）
      const fileMap = new Map();
      for (const c of chunkResults) {
        const key = c.file_path || c.file || "";
        if (!key) continue;
        const existing = fileMap.get(key);
        if (!existing || c.score > existing.score) {
          fileMap.set(key, { title: key, score: c.score, rank: fileMap.size + 1 });
        }
      }
      const fileResults = [...fileMap.values()];
      uniqueSourceCount = fileResults.length;

      // Recall@5 / Recall@10
      const top5Files = fileResults.slice(0, 5);
      const top10Files = fileResults.slice(0, 10);
      recallAt5 = top5Files.some((f) => fuzzyMatch(f.title, g.expectedGuide));
      recallAt10 = top10Files.some((f) => fuzzyMatch(f.title, g.expectedGuide));

      // MRR
      const guideMatch = findGuideInResults(fileResults, g.expectedGuide);
      if (guideMatch.hit) {
        firstRank = guideMatch.rank;
        mrr = 1 / guideMatch.rank;
      }

      // NDCG@5 / NDCG@10
      const relevance5 = top10Files.slice(0, 5).map((f) =>
        fuzzyMatch(f.title, g.expectedGuide) ? 1 :
        topGuides.some((tg) => fuzzyMatch(f.title, tg)) ? 0.5 : 0
      );
      const relevance10 = top10Files.map((f) =>
        fuzzyMatch(f.title, g.expectedGuide) ? 1 :
        topGuides.some((tg) => fuzzyMatch(f.title, tg)) ? 0.5 : 0
      );
      ndcg5 = ndcg(relevance5, 5);
      ndcg10 = ndcg(relevance10, 10);

    } catch (e) {
      console.warn(`  [${g.id}] 检索失败:`, e.message);
    }
  }

  caseResult.recallAt5 = recallAt5;
  caseResult.recallAt10 = recallAt10;
  caseResult.mrr = mrr;
  caseResult.ndcg5 = ndcg5;
  caseResult.ndcg10 = ndcg10;
  caseResult.firstRank = firstRank;
  caseResult.retrievedCount = retrievedCount;
  caseResult.uniqueSourceCount = uniqueSourceCount;
  caseResult.ms = parseInt(performance.now() - t0);

  perCaseResults.push(caseResult);

  if (FULL_MODE) {
    const routeLabels = { true: { true: "✅Top1", false: "⚠️Top3" }, false: "❌Miss" };
    const recallLabel = recallAt10 ? "✅" : "❌";
    console.log(
      `  ${routeHit ? "✅" : routeTop3 ? "⚠️" : "❌"} ${g.id}: ${g.query.slice(0, 30)}...` +
      `  路由Top1=${routeHit} 检索Recall@10=${recallAt10} MRR=${mrr.toFixed(3)} NDCG@5=${ndcg5.toFixed(3)}`
    );
  } else {
    const icon = routeHit ? "✅" : routeTop3 ? "⚠️" : "❌";
    console.log(`  ${icon} ${g.id}: ${g.query.slice(0, 30)}...  路由=${routeHit?"Top1":routeTop3?"Top3":"Miss"}  KG=${kgAllHit?"✅":"⚠️"}`);
  }
}

// ── 汇总统计 ──
const total = gold.length;
const routeHits = perCaseResults.filter((r) => r.routeHit).length;
const routeTop3Hits = perCaseResults.filter((r) => r.routeTop3).length;
const kgHits = perCaseResults.filter((r) => r.kgAllHit).length;

const summary = {
  date: new Date().toISOString(),
  mode: FULL_MODE ? "full" : "light",
  total,
  // 路由指标（与 eval-retrieval.mjs 一致）
  routeTop1Accuracy: routeHits / total,
  routeTop3Accuracy: routeTop3Hits / total,
  kgCoverage: kgHits / total,
  // 检索层元指标（仅在 full 模式有效）
  ...(FULL_MODE ? {
    recallAt5: perCaseResults.filter((r) => r.recallAt5).length / total,
    recallAt10: perCaseResults.filter((r) => r.recallAt10).length / total,
    mrr: perCaseResults.reduce((s, r) => s + r.mrr, 0) / total,
    ndcg5: perCaseResults.reduce((s, r) => s + r.ndcg5, 0) / total,
    ndcg10: perCaseResults.reduce((s, r) => s + r.ndcg10, 0) / total,
    zeroResultRate: totalZeroResult / total,
    nonzeroResultRate: 1 - totalZeroResult / total,
    avgRetrievedCount: perCaseResults.reduce((s, r) => s + r.retrievedCount, 0) / total,
    avgUniqueSources: perCaseResults.reduce((s, r) => s + r.uniqueSourceCount, 0) / total,
    // 有结果的情况下的 MRR（排除空结果）
    mrrNonZero: (() => {
      const nonzero = perCaseResults.filter((r) => r.firstRank !== null);
      return nonzero.length > 0
        ? nonzero.reduce((s, r) => s + r.mrr, 0) / nonzero.length
        : 0;
    })(),
  } : {}),
  // 阈值建议
  thresholds: {
    routeTop1Min: 0.85,       // 路由 Top1 ≥ 85%  —— CI HARD
    kgCoverageMin: 0.85,      // KG 覆盖率 ≥ 85%   —— CI HARD
    recallAt5Min: 0.75,       // Recall@5 ≥ 75%     —— CI WARN（新指标，初始宽松）
    recallAt10Min: 0.85,      // Recall@10 ≥ 85%    —— CI WARN
    mrrMin: 0.80,             // MRR ≥ 0.80          —— CI WARN
    zeroResultRateMax: 0.05,  // 空结果率 ≤ 5%       —— CI WARN
  },
  passed:
    routeHits / total >= 0.85 &&
    kgHits / total >= 0.85,
  averageMs: perCaseResults.reduce((s, r) => s + r.ms, 0) / total,
  results: perCaseResults,
};

// ── 输出报告 ──
const reportDir = join(ROOT, "tests", "reports");
mkdirSync(reportDir, { recursive: true });
const reportPath = join(reportDir, "retrieval-metrics.json");
writeFileSync(reportPath, JSON.stringify(summary, null, 2), "utf-8");

// ── 控制台输出 ──
console.log(`\n${"=".repeat(52)}`);
console.log(`  检索层元指标报告`);
console.log(`${"=".repeat(52)}`);
console.log(`模式: ${FULL_MODE ? "全量（含 chunk 检索）" : "轻量（路由 + KG）"}`);
console.log(`测试集: ${total} 条`);
console.log();
console.log(`── 路由指标 ──`);
console.log(`  Top1 准确率:    ${(summary.routeTop1Accuracy * 100).toFixed(1)}%  (${routeHits}/${total})`);
console.log(`  Top3 准确率:    ${(summary.routeTop3Accuracy * 100).toFixed(1)}%  (${routeTop3Hits}/${total})`);
console.log(`  KG 覆盖率:      ${(summary.kgCoverage * 100).toFixed(1)}%  (${kgHits}/${total})`);

if (FULL_MODE) {
  console.log();
  console.log(`── 检索元指标（full 模式）──`);
  console.log(`  Recall@5:      ${(summary.recallAt5 * 100).toFixed(1)}%`);
  console.log(`  Recall@10:     ${(summary.recallAt10 * 100).toFixed(1)}%`);
  console.log(`  MRR:           ${summary.mrr.toFixed(4)}`);
  console.log(`  MRR(非空):     ${(summary.mrrNonZero || 0).toFixed(4)}`);
  console.log(`  NDCG@5:        ${summary.ndcg5.toFixed(4)}`);
  console.log(`  NDCG@10:       ${summary.ndcg10.toFixed(4)}`);
  console.log(`  空结果率:      ${(summary.zeroResultRate * 100).toFixed(1)}%`);
  console.log(`  平均检索数:    ${summary.avgRetrievedCount.toFixed(1)}`);
  console.log(`  平均来源数:    ${summary.avgUniqueSources.toFixed(1)}`);
}

console.log();
console.log(`── 门禁阈值 ──`);
const check = (label, ok, got, want) =>
  console.log(`  ${ok ? "✅" : "❌"} ${label}: 实测 ${got}, 阈值 ${want}`);
check("路由 Top1 ≥ 85%", summary.routeTop1Accuracy >= 0.85, (summary.routeTop1Accuracy * 100).toFixed(1) + "%", "≥85%");
check("KG 覆盖率 ≥ 85%", summary.kgCoverage >= 0.85, (summary.kgCoverage * 100).toFixed(1) + "%", "≥85%");
if (FULL_MODE) {
  check("Recall@5 ≥ 75%", summary.recallAt5 >= 0.75, (summary.recallAt5 * 100).toFixed(1) + "%", "≥75%");
  check("Recall@10 ≥ 85%", summary.recallAt10 >= 0.85, (summary.recallAt10 * 100).toFixed(1) + "%", "≥85%");
  check("MRR ≥ 0.80", summary.mrr >= 0.80, summary.mrr.toFixed(3), "≥0.80");
  check("空结果率 ≤ 5%", summary.zeroResultRate <= 0.05, (summary.zeroResultRate * 100).toFixed(1) + "%", "≤5%");
}

console.log(`\n报告已写入: ${reportPath}`);

if (!summary.passed) {
  console.error("\n❌ 检索评测未通过核心门禁");
  process.exit(1);
}
