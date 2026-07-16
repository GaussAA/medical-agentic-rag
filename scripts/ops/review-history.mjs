#!/usr/bin/env node
// ============================================================
// review-history.mjs — 历史回答质量回溯分析
//
// 扫描 .pi/sessions/*.jsonl，提取每轮问答，调 llm-judge 四维评分，
// 输出质量报告到 tests/reports/history-quality-report.json。
//
// 维度：faithfulness / answerRelevance / clinicalCorrectness / safety
// 每项 0.0~1.0，基于 LLM 评审（免费优先）。
//
// 用法：
//   node scripts/ops/review-history.mjs                       # 全部会话
//   node scripts/ops/review-history.mjs --since 2026-07-15    # 仅指定日期后
//   node scripts/ops/review-history.mjs --limit 5             # 仅评前 N 条
//
// 输出：
//   tests/reports/history-quality-report.json  — 完整报告
//   控制台摘要
// ============================================================
import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = join(fileURLToPath(import.meta.url), "..");
const ROOT = join(__dirname, "..", "..");
const SESSIONS_DIR = join(ROOT, ".pi", "sessions");
const REPORT_DIR = join(ROOT, "tests", "reports");
const REPORT_FILE = join(REPORT_DIR, "history-quality-report.json");

// 解析参数
const args = process.argv.slice(2);
const SINCE = args.includes("--since") ? args[args.indexOf("--since") + 1] : null;
const LIMIT = args.includes("--limit") ? parseInt(args[args.indexOf("--limit") + 1], 10) : Infinity;

// ---------- 会话文件解析 ----------

/** 从一条 session JSONL 中提取问答对 */
function extractQAPairs(events) {
  const pairs = [];
  let currentQuestion = null;

  for (const e of events) {
    if (e.type !== "message") continue;
    const msg = e.message;
    if (!msg) continue;

    if (msg.role === "user") {
      // 新问题开始，先保存上一条未完成的
      currentQuestion = extractText(msg.content);
    } else if (msg.role === "assistant" && currentQuestion) {
      const answerText = extractFinalAnswer(msg.content);
      if (answerText) {
        pairs.push({ question: currentQuestion, answer: answerText });
        currentQuestion = null; // 已配对，清空等待下一轮
      }
    }
  }
  return pairs;
}

/** 从消息 content（可能为字符串或数组）提取纯文本 */
function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .join("\n");
  }
  return String(content);
}

/** 提取助手的最终回答文本（跳过 thinking 和 toolCall 块） */
function extractFinalAnswer(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const texts = content
      .filter((p) => p.type === "text")
      .map((p) => p.text || "")
      .filter(Boolean);
    return texts.length > 0 ? texts[texts.length - 1] : "";
  }
  return "";
}

/** 读取并解析一个 session JSONL 文件 */
function loadSession(filePath) {
  try {
    const text = readFileSync(filePath, "utf-8");
    const events = text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    const sessionMeta = events.find((e) => e.type === "session");
    const sessionId = sessionMeta?.id || "unknown";
    const timestamp = sessionMeta?.timestamp || "";

    const pairs = extractQAPairs(events);
    return { sessionId, timestamp, file: filePath, pairs };
  } catch (err) {
    return { sessionId: "error", file: filePath, pairs: [], error: err.message };
  }
}

/** 扫描所有会话文件 */
function loadAllSessions() {
  if (!existsSync(SESSIONS_DIR)) {
    console.error("[review] 会话目录不存在:", SESSIONS_DIR);
    return [];
  }
  const files = readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()
    .map((f) => join(SESSIONS_DIR, f));

  if (SINCE) {
    // 仅保留日期 >= SINCE 的会话（文件名含 ISO 时间戳）
    const cutoff = new Date(SINCE).getTime();
    return files.filter((f) => {
      try {
        const content = readFileSync(f, "utf-8");
        const first = JSON.parse(content.split("\n").find(Boolean) || "{}");
        return new Date(first.timestamp || 0).getTime() >= cutoff;
      } catch {
        return false;
      }
    });
  }
  return files;
}

// ---------- 主流程 ----------

async function main() {
  console.log("=".repeat(60));
  console.log("  历史回答质量回溯分析");
  console.log("=".repeat(60));

  // 1) 装载会话
  const sessionFiles = loadAllSessions();
  console.log(`\n扫描到 ${sessionFiles.length} 个会话文件`);

  const sessions = sessionFiles.map(loadSession);
  const validSessions = sessions.filter((s) => s.pairs.length > 0);
  const totalPairs = validSessions.reduce((sum, s) => sum + s.pairs.length, 0);
  console.log(`有效会话: ${validSessions.length}, 问答对: ${totalPairs}`);

  if (totalPairs === 0) {
    console.log("\n⚠ 无问答对可评估");
    const report = { ts: new Date().toISOString(), totalPairs: 0, sessions: [] };
    mkdirSync(REPORT_DIR, { recursive: true });
    writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf-8");
    console.log(`空报告已写入 ${REPORT_FILE}`);
    return;
  }

  // 2) 加载 llm-judge（延迟加载，仅在需要时引入）
  let judgeAnswer;
  try {
    const judge = await import("../../.pi/extensions/lib/llm-judge.mjs");
    judgeAnswer = judge.judgeAnswer;
  } catch (err) {
    console.error("\n❌ 加载 llm-judge 失败:", err.message);
    console.error("   请确认 .pi/extensions/lib/llm-judge.mjs 存在且 API Key 已配置");
    process.exit(1);
  }

  // 3) 逐条评审
  const results = [];
  let evaluated = 0;
  let skipped = 0;
  const limit = Math.min(LIMIT, totalPairs);

  // 展平所有问答对
  const flat = [];
  for (const s of validSessions) {
    for (const pair of s.pairs) {
      flat.push({ ...pair, sessionId: s.sessionId, sessionTs: s.timestamp });
    }
  }

  console.log(`\n开始评审 ${limit} 条问答...`);

  for (let i = 0; i < limit; i++) {
    const { question, answer, sessionId, sessionTs } = flat[i];
    const qPreview = question.slice(0, 60).replace(/\n/g, " ");
    console.log(`  [${i + 1}/${limit}] "${qPreview}..."`);

    try {
      const score = await judgeAnswer({
        question,
        answer,
        // 会话文件中无 referenceAnswer / gtSources，传空让 llm-judge 纯评分
        referenceAnswer: "",
        gtSources: [],
      });
      if (score.skipped) {
        skipped++;
        console.log(`    ⏭ 跳过: ${score.reason}`);
        results.push({ sessionId, sessionTs, question: qPreview, skipped: true, reason: score.reason });
      } else {
        evaluated++;
        console.log(`    ✅ F=${score.faithfulness} R=${score.answerRelevance} C=${score.clinicalCorrectness} S=${score.safety}`);
        results.push({
          sessionId,
          sessionTs,
          question: qPreview,
          skipped: false,
          faithfulness: score.faithfulness,
          answerRelevance: score.answerRelevance,
          clinicalCorrectness: score.clinicalCorrectness,
          safety: score.safety,
        });
      }
    } catch (err) {
      skipped++;
      console.log(`    ❌ 评审异常: ${err.message}`);
      results.push({ sessionId, sessionTs, question: qPreview, skipped: true, reason: "exception:" + err.message });
    }
  }

  // 4) 聚合统计
  const scored = results.filter((r) => !r.skipped);
  const avg = (key) => {
    const vals = scored.map((r) => r[key]).filter((v) => v !== undefined && v !== null);
    return vals.length > 0 ? (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3) : "N/A";
  };

  const summary = {
    ts: new Date().toISOString(),
    totalPairs,
    evaluated,
    skipped,
    avgFaithfulness: avg("faithfulness"),
    avgRelevance: avg("answerRelevance"),
    avgClinical: avg("clinicalCorrectness"),
    avgSafety: avg("safety"),
    dimensions: ["faithfulness", "answerRelevance", "clinicalCorrectness", "safety"],
  };

  // 低分清单（任何维度 < 0.7）
  const lowScores = scored.filter(
    (r) =>
      (r.faithfulness !== undefined && r.faithfulness < 0.7) ||
      (r.answerRelevance !== undefined && r.answerRelevance < 0.7) ||
      (r.clinicalCorrectness !== undefined && r.clinicalCorrectness < 0.7) ||
      (r.safety !== undefined && r.safety < 0.7)
  );
  summary.lowScoreCount = lowScores.length;

  // 5) 输出报告
  const report = { summary, results };
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2), "utf-8");

  console.log("\n" + "=".repeat(60));
  console.log("  评审完成");
  console.log("=".repeat(60));
  console.log(`  总问答对 : ${totalPairs}`);
  console.log(`  已评估   : ${evaluated}`);
  console.log(`  跳过     : ${skipped}`);
  console.log(`  低分条目 : ${lowScores.length}`);
  if (evaluated > 0) {
    console.log(`\n  四维均值:`);
    console.log(`    忠实度 (faithfulness)         : ${summary.avgFaithfulness}`);
    console.log(`    相关性 (answerRelevance)       : ${summary.avgRelevance}`);
    console.log(`    临床准确性 (clinicalCorrectness): ${summary.avgClinical}`);
    console.log(`    安全性 (safety)                : ${summary.avgSafety}`);
  }
  console.log(`\n  报告已写入: ${REPORT_FILE}`);
}

main().catch((err) => {
  console.error("[review] 执行失败:", err);
  process.exit(1);
});
