/**
 * backfill.test.mjs — scripts/wiki/backfill-from-eval.mjs 核心函数单测
 *
 * 测试 slugify、generateAnalysisPage、格式日期 等纯函数。
 *
 * 运行：node tests/unit/scripts/wiki/backfill.test.mjs
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

// ── 从 backfill 复制纯函数（无文件副作用）──
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

// ── 测试框架 ──
let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name); console.error("  ✗", name, detail); }
}

// ── 测试用例 ──

// [1] slugify 中文
{
  const s = slugify("幽门螺杆菌感染现在一般怎么根除");
  ok(s.includes("幽门螺杆菌"), "中文保留");
  ok(!s.includes(" "), "无空格");
  ok(!s.startsWith("-") && !s.endsWith("-"), "无首尾连字符");
}

// [2] slugify 边界
{
  ok(slugify("") === "", "空串");
  ok(slugify("  a b  ") === "a-b", "空白折叠");
  ok(slugify("高血压治疗") === "高血压治疗", "纯中文无分隔符");
}

// [3] generateAnalysisPage 结构
{
  const page = generateAnalysisPage({
    id: "Q01",
    q: "高血压治疗目标",
    judge: {
      faithfulness: 0.9,
      answerRelevance: 0.95,
      clinicalCorrectness: 0.85,
      safety: 1,
      reasons: "回答基本忠实于指南",
    },
  });
  ok(page.slug.startsWith("eval-Q01-"), "slug 以 eval-Q01- 开头");
  ok(page.content.includes("type: analysis"), "含 type: analysis");
  ok(page.content.includes("evalId: Q01"), "含 evalId: Q01");
  ok(page.content.includes("0.900"), "忠实度格式正确");
  ok(page.content.includes("0.950"), "相关性格式正确");
  ok(page.content.includes("回答基本忠实于指南"), "含评语内容");
}

// [4] generateAnalysisPage 缺省值
{
  const page = generateAnalysisPage({
    id: "Q99",
    q: "测试",
    judge: { faithfulness: null, answerRelevance: undefined },
  });
  ok(page.content.includes("0.000"), "null/undefined 到 0.000");
  ok(page.content.includes("(无评语)"), "缺评语使用占位");
}

// [5] formatDate 格式
{
  const d = formatDate(new Date("2026-07-24T12:00:00Z"));
  ok(d === "2026-07-24", "日期格式 YYYY-MM-DD");
}

// ── 汇总 ──
console.log(`\nwiki-backfill 单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
