// check-recall-regression.mjs
// 召回率回归检测 —— KB 更新后自动检测引用召回是否下降。
//
// 原理：复刻 citation-check.mjs 的路由召回口径，在 CI 中与基线比对。
// 若 recall 下降超过阈值，阻断 CI（fail-closed），防止无意识 KB 变更拉低检索质量。
//
// 用法:
//   node scripts/ci/check-recall-regression.mjs                    # 检测当前 vs 基线
//   node scripts/ci/check-recall-regression.mjs --update-baseline  # 更新基线
//   node scripts/ci/check-recall-regression.mjs --report-only      # 仅输出当前 recall，不比对
//   node scripts/ci/check-recall-regression.mjs --threshold=0.05   # 自定义下降阈值（默认 5%）

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const REPORTS_DIR = join(ROOT, "tests", "reports");
const BASELINE_PATH = join(REPORTS_DIR, "recall-baseline.json");

// 加载 citation-check 模块的导出
const CC_MOD = pathToFileURL(join(ROOT, "scripts", "eval", "quality", "citation-check.mjs")).href;
const GR_MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/guide-router.mjs")).href;
const { resolveGtDisease } = await import(CC_MOD);
const { routeGuides, loadIndex } = await import(GR_MOD);
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");

/**
 * 运行当前召回率检测。
 * @param {object} [opts]
 * @param {number} [opts.topK=3]  取前 K 个路由结果做病种匹配
 * @param {object} [opts.index]   注入索引（用于单测，省略则从 ROOT 读取）
 * @returns {{ recall: number, totalQuestions: number, totalSources: number, hits: number, misses: Array, perQuestion: Array }}
 */
export function measureRecall(opts = {}) {
  const { topK = 3, index: customIndex, goldFile } = opts;
  const gold = JSON.parse(readFileSync(goldFile || GOLD_PATH, "utf-8"));
  const items = gold.items || gold;

  try {
    const index = customIndex || loadIndex(ROOT);
    let totalSources = 0;
    let hits = 0;
    const misses = [];
    const perQuestion = [];

    for (const item of items) {
      const q = item.q || item.question || "";
      const gtSources = item.gtSources || (item.gtSource ? [item.gtSource] : []);
      if (!q || gtSources.length === 0) continue;

      const route = routeGuides(q, { index, useCache: false });
      const topDiseases = route.top.slice(0, topK).map((g) => g.disease).filter(Boolean);

      let itemHits = 0;
      const matchedSources = [];
      const unmatchedSources = [];

      for (const src of gtSources) {
        const d = resolveGtDisease(src, index.guideMap);
        if (d && topDiseases.includes(d)) {
          itemHits++;
          matchedSources.push(src);
        } else {
          unmatchedSources.push(src);
        }
      }

      totalSources += gtSources.length;
      hits += itemHits;

      perQuestion.push({
        id: item.id || "?",
        q: q.slice(0, 40),
        sources: gtSources.length,
        hits: itemHits,
        recall: itemHits / Math.max(1, gtSources.length),
      });

      if (unmatchedSources.length > 0) {
        misses.push({
          id: item.id || "?",
          q: q.slice(0, 40),
          unmatched: unmatchedSources,
          topDiseases,
        });
      }
    }

    const recall = totalSources > 0 ? hits / totalSources : 0;
    return {
      recall: Number(recall.toFixed(4)),
      totalQuestions: items.length,
      totalSources,
      hits,
      misses,
      perQuestion,
      topK,
    };
  } catch (err) {
    return {
      error: `召回率检测失败: ${err instanceof Error ? err.message : err}`,
      recall: 0,
      totalQuestions: 0,
      totalSources: 0,
      hits: 0,
      misses: [],
      perQuestion: [],
      topK,
    };
  }
}

/**
 * 加载召回率基线。
 */
function loadBaseline() {
  try {
    if (!existsSync(BASELINE_PATH)) return null;
    return JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * 保存召回率基线。
 */
function saveBaseline(data) {
  mkdirSync(REPORTS_DIR, { recursive: true });
  const baseline = {
    generatedAt: new Date().toISOString(),
    ...data,
  };
  writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2), "utf-8");
  return baseline;
}

function fmtPct(v) {
  return (v * 100).toFixed(1) + "%";
}

function main() {
  const args = process.argv.slice(2);
  const UPDATE = args.includes("--update-baseline");
  const REPORT_ONLY = args.includes("--report-only");
  const thresholdArg = args.find((a) => a.startsWith("--threshold="));
  const THRESHOLD = thresholdArg ? Number(thresholdArg.split("=")[1]) : 0.05;
  const TOP_K = 3;

  console.log("━━━ 引用召回率回归检测 ━━━\n");

  // 测量当前召回率
  const current = measureRecall({ topK: TOP_K });

  if (current.error) {
    console.error(`✗ ${current.error}`);
    process.exit(2);
  }

  console.log(`  gold 题数:     ${current.totalQuestions}`);
  console.log(`  总引用源数:   ${current.totalSources}`);
  console.log(`  命中数:        ${current.hits}`);
  console.log(`  当前召回率:    ${fmtPct(current.recall)}`);

  if (current.misses.length > 0) {
    console.log(`\n⚠ 未命中条目 (${current.misses.length}):`);
    for (const m of current.misses.slice(0, 10)) {
      console.log(`  [${m.id}] ${m.q}`);
      console.log(`    top3 病种: ${m.topDiseases.join("、") || "(空)"}`);
      for (const u of m.unmatched) {
        console.log(`    ✗ 未命中: ${u}`);
      }
    }
    if (current.misses.length > 10) {
      console.log(`  ... 还有 ${current.misses.length - 10} 条省略`);
    }
  }

  // 更新基线
  if (UPDATE) {
    const baseline = saveBaseline({ recall: current.recall, topK: current.topK, totalQuestions: current.totalQuestions });
    console.log(`\n✓ 基线已更新: ${fmtPct(baseline.recall)} (${baseline.generatedAt})`);
    process.exit(0);
  }

  // 仅报告
  if (REPORT_ONLY) {
    process.exit(0);
  }

  // 与基线对比
  const baseline = loadBaseline();

  if (!baseline) {
    console.log(`\n⚠ 无基线可用。请先运行 --update-baseline 建立基线。`);
    console.log(`  当前召回率: ${fmtPct(current.recall)}`);
    process.exit(2);
  }

  const prevRecall = baseline.recall || 0;
  const delta = current.recall - prevRecall;

  console.log(`\n── 对比基线 ──`);
  console.log(`  基线召回率:   ${fmtPct(prevRecall)} (${baseline.generatedAt || "?"})`);
  console.log(`  当前召回率:   ${fmtPct(current.recall)}`);
  console.log(`  变化:         ${delta >= 0 ? "+" : ""}${fmtPct(delta)}`);

  if (delta < -THRESHOLD) {
    console.log(`\n🔴 召回率下降超过阈值 (${fmtPct(Math.abs(delta))} > ${fmtPct(THRESHOLD)}) —— 阻断`);
    console.log(`  请检查最近的 KB 变更: npm run kb:update coverage`);
    process.exit(1);
  }

  if (delta < 0) {
    console.log(`\n🟡 召回率轻微下降 (${fmtPct(Math.abs(delta))})，但未超阈值 (${fmtPct(THRESHOLD)}) —— 放行`);
    process.exit(0);
  }

  console.log(`\n✓ 召回率稳定或提升 —— 通过`);
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
