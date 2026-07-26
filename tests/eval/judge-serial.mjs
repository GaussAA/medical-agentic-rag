/**
 * 串行评测（避让 API 限流）
 *
 * 逐条评测 65 条黄金答案，每条间隔 ~30s（可配置），
 * 尊重免费 API 的 RPM 配额，避免 429。
 * 中间结果实时保存，中断可续跑。
 *
 * 用法：
 *   LLM_JUDGE_MODEL=agnes/agnes-2.0-flash node tests/eval/judge-serial.mjs
 *   LLM_JUDGE_MODEL=sensenova/deepseek-v4-flash node tests/eval/judge-serial.mjs
 *
 * 默认间隔 30s，可通过 --delay 调整：
 *   LLM_JUDGE_MODEL=agnes/agnes-2.0-flash node tests/eval/judge-serial.mjs --delay 20
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const CACHE_PATH = join(ROOT, "tests", "reports", "judge-serial-cache.json");
const REPORT_PATH = join(ROOT, "tests", "reports", "judge-serial-report.json");
const DELAY_MS = (parseInt(process.argv.find(a => a.startsWith("--delay="))?.split("=")[1] || process.argv[process.argv.indexOf("--delay") + 1]) || 30) * 1000;

console.log(`串行评测 · 间隔 ${DELAY_MS / 1000}s · JUDGE_MODEL=${process.env.LLM_JUDGE_MODEL || "默认"}`);

// ── 载入黄金答案 ──
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
const items = gold.items || [];
console.log(`黄金答案集: ${items.length} 条`);

// ── 载入缓存（断点续跑）──
const cache = existsSync(CACHE_PATH) ? JSON.parse(readFileSync(CACHE_PATH, "utf-8")) : { results: [] };
const doneIds = new Set(cache.results.map((r) => r.id));
console.log(`已缓存: ${doneIds.size}/${items.length} 条`);

// ── 动态导入 llm-judge ──
const { judgeAnswer } = await import("../../.pi/extensions/lib/llm-judge.mjs");

let consecutive429 = 0;

for (const item of items) {
  if (doneIds.has(item.id)) {
    console.log(`  [${item.id}] 跳过（已缓存）`);
    continue;
  }

  // 前一条结束后等待（防限流）
  if (doneIds.size > 0 || cache.results.length > 0) {
    const waitMs = DELAY_MS + Math.round(Math.random() * 5000);
    console.log(`  等待 ${Math.round(waitMs / 100) / 10}s...`);
    await new Promise((r) => setTimeout(r, waitMs));
  }

  console.log(`  [${item.id}] ${item.q.slice(0, 36)}...`);
  const start = Date.now();
  
  try {
    const result = await judgeAnswer({
      question: item.q,
      answer: item.systemAnswer || item.referenceAnswer,
      referenceAnswer: item.referenceAnswer,
      gtSources: item.gtSources || [],
    });

    if (result.skipped) {
      console.log(`    ❌ 跳过（${result.reason || "未知"}）`);
    } else {
      console.log(`    ✅ faith=${result.faithfulness} rel=${result.answerRelevance} clin=${result.clinicalCorrectness} saf=${result.safety} (${Date.now() - start}ms)`);
    }

    // 如果 429 连续多次，自动增加间隔
    const was429 = result.skipped && /429|limit|quota/i.test(result.reason || "");
    if (was429) {
      consecutive429++;
      if (consecutive429 >= 3) {
        const extra = 60000;
        console.log(`  连续 ${consecutive429} 次 429，额外等待 ${extra / 1000}s...`);
        await new Promise((r) => setTimeout(r, extra));
      }
    } else {
      consecutive429 = 0;
    }

    cache.results.push({
      id: item.id,
      department: item.department,
      difficulty: item.difficulty,
      question: item.q.slice(0, 40),
      judgeModel: process.env.LLM_JUDGE_MODEL || "default",
      skipped: result.skipped,
      faithfulness: result.faithfulness,
      answerRelevance: result.answerRelevance,
      clinicalCorrectness: result.clinicalCorrectness,
      safety: result.safety,
      reasons: (result.reasons || "").slice(0, 200),
      latencyMs: Date.now() - start,
      timestamp: new Date().toISOString(),
    });

    // 实时保存缓存
    writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

  } catch (e) {
    console.log(`    💥 异常: ${e?.message?.slice(0, 80)}`);
    // 异常也等 60s 后再继续
    await new Promise((r) => setTimeout(r, 60000));
  }
}

// ── 输出报告 ──
const results = cache.results;
const valid = results.filter((r) => !r.skipped);
const total = valid.length;
const avg = (field) => total > 0 ? (valid.reduce((s, r) => s + (r[field] || 0), 0) / total).toFixed(3) : "N/A";

const report = {
  model: process.env.LLM_JUDGE_MODEL || "default",
  total: results.length,
  success: total,
  skipped: results.length - total,
  avgFaithfulness: avg("faithfulness"),
  avgRelevance: avg("answerRelevance"),
  avgClinical: avg("clinicalCorrectness"),
  avgSafety: avg("safety"),
  items: results,
  generatedAt: new Date().toISOString(),
};

writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf-8");
writeFileSync(CACHE_PATH, JSON.stringify(cache, null, 2), "utf-8");

console.log(`\n===== 串行评测完成 =====`);
console.log(`模型: ${report.model}`);
console.log(`成功/总计: ${total}/${results.length}`);
console.log(`忠实度: ${avg("faithfulness")}`);
console.log(`相关性: ${avg("answerRelevance")}`);
console.log(`临床正确性: ${avg("clinicalCorrectness")}`);
console.log(`安全性: ${avg("safety")}`);
console.log(`报告已写入: ${REPORT_PATH}`);
