#!/usr/bin/env node
/**
 * wiki-backfill-from-eval — 将 LLM-Judge 高置信度问答对回填到 LLM Wiki
 *
 * 从 answer-quality-report.json 中筛选忠实≥0.9 且相关≥0.95 的问答对，
 * 写入 .llm-wiki/wiki/analyses/ 作为持久分析页面。
 *
 * 使用：node scripts/wiki/backfill-from-eval.mjs [--report path] [--threshold-faithful 0.9] [--threshold-relevance 0.95]
 *
 * 集成到 CI：在 eval:full 之后调用
 *   node scripts/eval/pipeline/eval-full.mjs && node scripts/wiki/backfill-from-eval.mjs
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// ── 配置 ──
const PROJECT_ROOT = process.cwd();
const DEFAULT_REPORT = join(PROJECT_ROOT, "tests", "reports", "answer-quality-report.json");
const WIKI_ANALYSES_DIR = join(PROJECT_ROOT, ".llm-wiki", "wiki", "analyses");

const args = process.argv.slice(2);
const reportPath = args.includes("--report")
  ? resolve(args[args.indexOf("--report") + 1])
  : DEFAULT_REPORT;

const thresholdFaithful = args.includes("--threshold-faithful")
  ? parseFloat(args[args.indexOf("--threshold-faithful") + 1])
  : 0.9;

const thresholdRelevance = args.includes("--threshold-relevance")
  ? parseFloat(args[args.indexOf("--threshold-relevance") + 1])
  : 0.95;

const dryRun = args.includes("--dry-run");

// ── 工具函数 ──
function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function formatDate(date) {
  return date.toISOString().split("T")[0];
}

function generateAnalysisPage(entry) {
  const { id, q, judge } = entry;
  const slug = `eval-${id}-${slugify(q.slice(0, 30))}`;
  const today = formatDate(new Date());

  // 从 judge 评语中提取核心摘要
  const reason = judge.reasons || "(无评语)";
  const faithfulness = (judge.faithfulness ?? 0).toFixed(3);
  const relevance = (judge.answerRelevance ?? 0).toFixed(3);
  const clinical = (judge.clinicalCorrectness ?? 0).toFixed(3);
  const safety = (judge.safety ?? 0).toFixed(3);

  const pageContent = `---
type: analysis
created: ${today}
updated: ${today}
source: llm-judge-eval
evalId: ${id}
scores:
  faithfulness: ${faithfulness}
  relevance: ${relevance}
  clinical: ${clinical}
  safety: ${safety}
---

# ${id}: ${q}

## 问题

${q}

## 分析

${reason}

## 质量评分

| 维度 | 分数 |
|------|------|
| 忠实度 | ${faithfulness} |
| 相关性 | ${relevance} |
| 临床正确性 | ${clinical} |
| 安全性 | ${safety} |

> 由 LLM-Judge 评测自动回填 · ${today}
`;

  return { slug, content: pageContent };
}

// ── 主流程 ──
async function main() {
  console.log(`🔍 Wiki 回填：从 ${reportPath} 筛选忠实≥${thresholdFaithful} 且相关≥${thresholdRelevance}`);

  // 检查报告是否存在
  if (!existsSync(reportPath)) {
    console.log(`⚠️  评测报告不存在: ${reportPath}`);
    console.log("   跳过回填（首次运行或尚未执行评测）");
    process.exit(0);
  }

  // 检查 wiki analyses 目录
  if (!existsSync(WIKI_ANALYSES_DIR)) {
    if (dryRun) {
      console.log(`⚠️  wiki 目录不存在: ${WIKI_ANALYSES_DIR}`);
      console.log("   (dry-run 模式，不创建)");
    } else {
      mkdirSync(WIKI_ANALYSES_DIR, { recursive: true });
      console.log(`📁 创建 wiki analyses 目录: ${WIKI_ANALYSES_DIR}`);
    }
  }

  // 读取评测报告
  let report;
  try {
    report = JSON.parse(readFileSync(reportPath, "utf-8"));
  } catch (e) {
    console.error(`❌ 读取评测报告失败: ${e.message}`);
    process.exit(1);
  }

  const details = report.details || [];
  if (details.length === 0) {
    console.log("⚠️  评测报告中无条目详情");
    process.exit(0);
  }

  // 筛选高置信度条目
  const qualified = details.filter((d) => {
    const judge = d.judge || {};
    if (judge.skipped) return false;
    return (judge.faithfulness ?? 0) >= thresholdFaithful
        && (judge.answerRelevance ?? 0) >= thresholdRelevance;
  });

  console.log(`\n📊 评测条目: ${details.length} 总 → ${qualified.length} 合格（跳过 ${details.length - qualified.length}）`);

  if (qualified.length === 0) {
    console.log("   无合格条目可回填");
    process.exit(0);
  }

  // 生成并写入页面
  let written = 0;
  let skipped = 0;

  for (const entry of qualified) {
    const { slug, content } = generateAnalysisPage(entry);
    const filePath = join(WIKI_ANALYSES_DIR, `${slug}.md`);

    if (existsSync(filePath) && !args.includes("--force")) {
      console.log(`   ⏭  跳过（已存在）: ${slug}`);
      skipped++;
      continue;
    }

    if (dryRun) {
      console.log(`   📄 [dry-run] 将写入: ${slug}.md (${content.length} 字符)`);
      written++;
      continue;
    }

    writeFileSync(filePath, content, "utf-8");
    console.log(`   ✅ 写入: ${slug}.md`);
    written++;
  }

  // 完成
  if (dryRun) {
    console.log(`\n🏁 dry-run 完成：${written} 篇待写入，${skipped} 篇跳过`);
  } else {
    console.log(`\n🏁 ���填完成：${written} 篇写入，${skipped} 篇跳过`);

    // 触发 wiki 元数据重建
    console.log("   提示：运行以下命令重建 wiki 索引:");
    console.log("     pi -p \"Rebuild wiki metadata\"");
  }
}

main().catch((e) => {
  console.error(`❌ 回填失败: ${e.message}`);
  process.exit(1);
});
