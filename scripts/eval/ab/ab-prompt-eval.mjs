// ab-prompt-eval.mjs
// 提示词 A/B 自调优评测引擎 —— 维度⑤反馈闭环的「二次调优」量化臂。
//
// 背景：评测体系分析指出，当前「运行时信号→薄弱点→建议→gold候选」已通，但所有二次调优动作
// （改 prompts/medical-agent.md、补 KB、并 gold）均须人工拍板，无「量化对比」环节。
// 当有人基于反馈热点修正案改 medical-agent.md 时，如何判定这次改动是变好还是变差？
// 本工具给出答案：给定 A（当前 prompt）与 B（修正案）在 gold 问题集上的两套答案，
// 复用 llm-judge 单一真相源跑四维 judge，聚合均值对比 + 回归判定 + 采纳建议。
//
// 设计要点（贴合项目既有约束）：
//   1) 复用 .pi/extensions/lib/llm-judge.mjs 的 judgeAnswer —— 四维口径、免费优先、密钥池、有界并发，零重造。
//   2) 生成与评测解耦：本工具只做「judge 对比」，A/B 两套答案由 input JSON 外部喂入
//      （生成侧可复用现有 eval / Pi CLI，不在 MVP 内绑死运行时，避免 41 题生成成本爆炸）。
//   3) 纯函数（aggregate/compareDimensions/decideVerdict/buildReport）与 LLM 调用解耦，
//      供 tests/unit/ab-prompt-eval-test.mjs 注入数据零 Key 单测。
//   4) 安全护栏：safety 维度硬约束（绝不可回退），其余维度 WARN 阈值；A/B 结果仅产 candidate，
//      **绝不写 gold-answers.json**（沿用 mergeIntoGold 守卫理念，防错误候选污染金标准）。
//
// 用法：
//   node scripts/eval/ab/ab-prompt-eval.mjs --input ab-input.json
//   node scripts/eval/ab/ab-prompt-eval.mjs --input ab-input.json --limit 3   # 仅前 3 题（控成本）
//   node scripts/eval/ab/ab-prompt-eval.mjs --input ab-input.json --report out.json
//
// input JSON 结构：
//   { "meta": { "promptA": "...", "promptB": "...", "note": "..." },
//     "items": [ { "id":"Q1", "q":"问题", "gtSources":[...], "referenceAnswer":"...",
//                  "answerA":"A侧答案", "answerB":"B侧答案" }, ... ] }

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import {
  judgeAnswer,
  JUDGE_DIMENSIONS,
  isLLMAvailable,
  runWithConcurrency,
} from "../../../.pi/extensions/lib/llm-judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 稳健解析项目根：向上递归找 package.json（不写死 ../ 层数）。
function findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
const ROOT = findProjectRoot(__dirname);

// ---------- 纯函数：聚合与对比 ----------

/**
 * 单维均值（排除 skipped 无效项）。
 * @param {Array<{faithfulness?:number,answerRelevance?:number,clinicalCorrectness?:number,safety?:number,skipped?:boolean}>} scoresArr
 * @param {string} dim
 * @returns {{mean:number, valid:number}}
 */
function dimMean(scoresArr, dim) {
  const vals = scoresArr.filter((s) => s && !s.skipped && typeof s[dim] === "number").map((s) => s[dim]);
  if (vals.length === 0) return { mean: 0, valid: 0 };
  return { mean: +(vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(4), valid: vals.length };
}

/**
 * 聚合 A/B 两套评分的四维均值与差值。
 * @param {Array<{scoresA:object, scoresB:object}>} pairs  每项为同一题的 A/B 评分（含 skipped 标记）
 * @returns {{meansA:object, meansB:object, deltas:object, validCount:number, total:number}}
 */
export function aggregate(pairs) {
  const scoresA = pairs.map((p) => p.scoresA);
  const scoresB = pairs.map((p) => p.scoresB);
  const meansA = {};
  const meansB = {};
  const deltas = {};
  for (const dim of JUDGE_DIMENSIONS) {
    const a = dimMean(scoresA, dim);
    const b = dimMean(scoresB, dim);
    meansA[dim] = a.mean;
    meansB[dim] = b.mean;
    deltas[dim] = +(b.mean - a.mean).toFixed(4);
  }
  const validCount = pairs.filter(
    (p) => p.scoresA && !p.scoresA.skipped && p.scoresB && !p.scoresB.skipped,
  ).length;
  return { meansA, meansB, deltas, validCount, total: pairs.length };
}

/**
 * 维度方向判定。
 * @param {{meansA:object, meansB:object, deltas:object}} agg  aggregate 输出
 * @param {{eps?:number}} [opts]  eps=方向判定死区（默认 1e-4）
 * @returns {{perDim:Array<{dim:string,meanA:number,meanB:number,delta:number,direction:'up'|'down'|'flat'}>, lifts:number, drops:number, net:number}}
 */
export function compareDimensions(agg, { eps = 1e-4 } = {}) {
  const perDim = JUDGE_DIMENSIONS.map((dim) => {
    const delta = agg.deltas[dim];
    const direction = delta > eps ? "up" : delta < -eps ? "down" : "flat";
    return { dim, meanA: agg.meansA[dim], meanB: agg.meansB[dim], delta, direction };
  });
  const lifts = perDim.filter((d) => d.direction === "up").length;
  const drops = perDim.filter((d) => d.direction === "down").length;
  return { perDim, lifts, drops, net: lifts - drops };
}

/**
 * 采纳裁决。
 * @param {{meansA:object, meansB:object, deltas:object}} agg
 * @param {{safetyHardDrop?:number, meanWarnDrop?:number}} [opts]
 *   safetyHardDrop: safety 回退超此值 → 硬性否决（默认 0.02，安全绝不可退）
 *   meanWarnDrop:   其余维度回退超此值 → 谨慎采纳（默认 0.03）
 * @returns {{verdict:'REJECT'|'ADOPT_WITH_CAUTION'|'ADOPT', reasons:string[]}}
 */
export function decideVerdict(agg, { safetyHardDrop = 0.02, meanWarnDrop = 0.03 } = {}) {
  const reasons = [];
  const safetyDelta = agg.deltas.safety ?? 0;

  // 维度1：安全硬约束 —— 绝不回退
  if (safetyDelta < -safetyHardDrop) {
    reasons.push(
      `安全维度回退 ${safetyDelta.toFixed(3)} 超硬阈值 ${safetyHardDrop}（安全护栏不可退），否决采纳`,
    );
    return { verdict: "REJECT", reasons };
  }

  // 维度2：其余维度回退 → 谨慎采纳
  const dropped = JUDGE_DIMENSIONS.filter(
    (d) => d !== "safety" && agg.deltas[d] < -meanWarnDrop,
  );
  if (dropped.length > 0) {
    reasons.push(`维度回退（超 WARN 阈值 ${meanWarnDrop}）: ${dropped.join("、")}，谨慎采纳`);
    return { verdict: "ADOPT_WITH_CAUTION", reasons };
  }

  // 维度3：有提升 → 采纳；持平无提升 → 谨慎采纳
  const lifted = JUDGE_DIMENSIONS.filter((d) => agg.deltas[d] > meanWarnDrop);
  if (lifted.length > 0) {
    reasons.push(`维度提升: ${lifted.join("、")}，建议采纳 B`);
    return { verdict: "ADOPT", reasons };
  }
  reasons.push("四维均持平、无显著提升，谨慎采纳（建议保留 A 或继续微调）");
  return { verdict: "ADOPT_WITH_CAUTION", reasons };
}

/**
 * 组装最终报告对象。
 * @param {object} input  原始 input（meta + items）
 * @param {Array<{id:string, q:string, scoresA:object, scoresB:object}>} judged  已 judge 的配对
 * @param {object} agg  aggregate 输出
 * @param {{verdict:string, reasons:string[]}} verdictObj  decideVerdict 输出
 * @param {object} config  运行配置（limit 等）
 */
export function buildReport(input, judged, agg, verdictObj, config) {
  const cmp = compareDimensions(agg);
  return {
    generatedAt: new Date().toISOString(),
    meta: input.meta || {},
    config,
    summary: {
      total: agg.total,
      validCount: agg.validCount,
      meansA: agg.meansA,
      meansB: agg.meansB,
      deltas: agg.deltas,
      comparison: cmp,
      verdict: verdictObj.verdict,
      reasons: verdictObj.reasons,
    },
    // 每题明细（含 skipped 标记，便于排查 judge 失败）
    items: judged.map((j) => ({
      id: j.id,
      q: j.q,
      skippedA: !!(j.scoresA && j.scoresA.skipped),
      skippedB: !!(j.scoresB && j.scoresB.skipped),
      scoresA: j.scoresA && !j.scoresA.skipped ? j.scoresA : null,
      scoresB: j.scoresB && !j.scoresB.skipped ? j.scoresB : null,
    })),
  };
}

// ---------- CLI ----------

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--input" && argv[i + 1]) a.input = argv[++i];
    else if (argv[i] === "--report" && argv[i + 1]) a.report = argv[++i];
    else if (argv[i] === "--limit" && argv[i + 1]) a.limit = parseInt(argv[++i], 10);
  }
  return a;
}

function printSummary(report) {
  const line = "─".repeat(64);
  console.log(line);
  console.log("医疗 Agentic RAG · 提示词 A/B 自调优评测");
  console.log(line);
  const s = report.summary;
  console.log(`题量: ${s.validCount}/${s.total} 有效（已排除 judge 跳过项）`);
  console.log("维度             A均值    B均值     Δ");
  for (const d of s.comparison.perDim) {
    const name = {
      faithfulness: "忠实度",
      answerRelevance: "相关性",
      clinicalCorrectness: "临床正确",
      safety: "安全性",
    }[d.dim];
    const arrow = d.direction === "up" ? "↑" : d.direction === "down" ? "↓" : "–";
    console.log(
      `  ${name.padEnd(8)}   ${d.meanA.toFixed(3)}   ${d.meanB.toFixed(3)}   ${d.delta >= 0 ? "+" : ""}${d.delta.toFixed(3)} ${arrow}`,
    );
  }
  console.log(line);
  console.log(`裁决: ${s.verdict}`);
  for (const r of s.reasons) console.log(`  · ${r}`);
  console.log(line);
}

const isMain =
  !!process.argv[1] &&
  basename(import.meta.url) === basename("file://" + (process.argv[1] || "").replace(/\\/g, "/"));

if (isMain) {
  try {
    const args = parseArgs(process.argv);
    if (!args.input) {
      console.error("用法: node scripts/kb/ab-prompt-eval.mjs --input <ab-input.json> [--limit N] [--report <path>]");
      process.exit(2);
    }
    if (!existsSync(args.input)) {
      console.error(`input 不存在: ${args.input}`);
      process.exit(2);
    }
    if (!isLLMAvailable()) {
      console.error("[ab-prompt-eval] 无可用 LLM 端点（需 SENSENOVA_API_KEYS 或 DEEPSEEK_API_KEY）");
      process.exit(3);
    }

    const input = JSON.parse(readFileSync(args.input, "utf-8"));
    let items = Array.isArray(input.items) ? input.items : [];
    if (args.limit && args.limit > 0) items = items.slice(0, args.limit);
    if (items.length === 0) {
      console.error("[ab-prompt-eval] input.items 为空");
      process.exit(2);
    }

    // 每题配对 judge A、B（有界并发吃满免费额度）
    const tasks = items.map((it) => async () => {
      const base = {
        question: it.q,
        referenceAnswer: it.referenceAnswer || "",
        gtSources: it.gtSources || [],
      };
      const [scoresA, scoresB] = await Promise.all([
        judgeAnswer({ ...base, answer: it.answerA || "" }),
        judgeAnswer({ ...base, answer: it.answerB || "" }),
      ]);
      return { id: it.id, q: it.q, scoresA, scoresB };
    });

    console.log(`对 ${items.length} 题执行 A/B 四维 judge（免费优先并发）...`);
    const judged = await runWithConcurrency(tasks, undefined);

    const agg = aggregate(judged);
    const verdictObj = decideVerdict(agg);
    const report = buildReport(input, judged, agg, verdictObj, {
      limit: args.limit || null,
      input: args.input,
    });

    const reportPath = args.report || join(ROOT, "tests", "reports", "ab-eval-report.json");
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");

    printSummary(report);
    console.log(`报告已写出: ${reportPath}`);
  } catch (e) {
    console.error("[ab-prompt-eval] 失败:", e.message);
    process.exit(1);
  }
}
