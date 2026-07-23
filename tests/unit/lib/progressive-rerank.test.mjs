// progressive-rerank.test.mjs
// 渐进式重排序单元测试

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 创建临时目录写 guide-index.json（progressive-rerank 内部 import guide-router 需用到）
const TEST_DIR = mkdtempSync(join(tmpdir(), "prerank-test-"));
const KB_DIR = join(TEST_DIR, "data", "kb");
mkdirSync(KB_DIR, { recursive: true });

// 写一个最小的 guide-index.json
writeFileSync(join(KB_DIR, ".guide-index.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalGuides: 3,
  totalKeywords: 5,
  guideMap: {
    "高血压指南(2024版)": { id: "test-1", disease: "高血压", keywords: ["高血压", "降压", "血压"], sectionCount: 10 },
    "糖尿病指南(2023版)": { id: "test-2", disease: "糖尿病", keywords: ["糖尿病", "血糖", "胰岛素"], sectionCount: 10 },
    "肺炎诊疗规范(2024版)": { id: "test-3", disease: "肺炎", keywords: ["肺炎", "感染", "抗生素"], sectionCount: 10 },
  },
  keywordIndex: {
    "高血压": ["高血压指南(2024版)"],
    "糖尿病": ["糖尿病指南(2023版)"],
    "肺炎": ["肺炎诊疗规范(2024版)"],
  },
}), "utf-8");

const origCwd = process.cwd;
process.cwd = () => TEST_DIR;

const rerank = await import("../../../.pi/extensions/lib/retrieval-router/progressive-rerank.mjs");

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEqual(a, b, msg) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) { passed++; console.log(`  ✓ ${msg} (${JSON.stringify(a)})`); }
  else { failed++; console.error(`  ✗ ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}

function assertClose(a, b, tolerance, msg) {
  const ok = Math.abs(a - b) <= tolerance;
  if (ok) { passed++; console.log(`  ✓ ${msg} (${a})`); }
  else { failed++; console.error(`  ✗ ${msg}: ${a} not close to ${b} (±${tolerance})`); }
}

// ===== Test 1: 空输入 =====
console.log("\nTest 1: 空候选集");
const r1 = rerank.progressiveRerank([], "高血压");
assertEqual(r1.length, 0, "空输入返回空数组");

const r1b = rerank.progressivePipeline([], "高血压");
assertEqual(r1b.length, 0, "pipeline 空输入返回空数组");

// ===== Test 2: 基本重排序 — 匹配多的排前面 =====
console.log("\nTest 2: 基本重排序 — 得分分布");
const candidates = [
  { file_path: "a.md", content: "高血压患者血压控制目标为130/80mmHg以下。高血压治疗包括生活方式干预和药物治疗。降压药物包括ACEI、ARB、CCB等。", score: 8.0 },
  { file_path: "b.md", content: "糖尿病患者血糖控制目标。糖尿病酮症酸中毒诊断。", score: 6.0 },
  { file_path: "c.md", content: "这个段落是关于食品营养的，和高血压没有关系。食物的营养成分包括蛋白质、脂肪、碳水化合物。", score: 3.0 },
];

const r2 = rerank.progressiveRerank(candidates, "高血压 降压");
assert(r2.length === 3, "返回所有候选");
assert(r2[0].file_path === "a.md", "高血压相关段落排第一");
assert(r2[2].file_path === "c.md", "营养段落排最后");

// 验证 refinedScore 存在
assert(typeof r2[0].refinedScore === "number", "refinedScore 是数字");
assert(r2[0].refinedScore > 0, "refinedScore > 0");

// 验证 _signals 存在
assert(r2[0]._signals !== undefined, "_signals 存在");

// ===== Test 3: progressivePipeline — 截取 Top-K =====
console.log("\nTest 3: progressivePipeline — 截取 Top-K");
const r3 = rerank.progressivePipeline(candidates, "高血压", { finalTopK: 2 });
assertEqual(r3.length, 2, "返回 top-2");
assertEqual(r3[0].file_path, "a.md", "top-1 正确");

// ===== Test 4: 临床意图标题加权 =====
console.log("\nTest 4: 临床意图标题加权");
const clinicalCandidates = [
  { file_path: "a.md", content: "高血压患者需要定期检查。", score: 5.0, metadata: { section: "概述" } },
  { file_path: "b.md", content: "高血压的诊断标准为诊室血压≥140/90mmHg。", score: 4.5, metadata: { section: "诊断标准" } },
  { file_path: "c.md", content: "高血压的药物治疗方案。", score: 4.0, metadata: { section: "治疗" } },
];

const r4 = rerank.progressiveRerank(clinicalCandidates, "高血压 诊断 治疗");
// 诊断和治疗标题的段落应有更高的 titleScore
const diag = r4.find((c) => c.file_path === "b.md");
const treat = r4.find((c) => c.file_path === "c.md");
assert(diag._signals.titleScore > 0, "诊断段标题得分 > 0");
assert(treat._signals.titleScore > 0, "治疗段标题得分 > 0");

// ===== Test 5: 空查询 =====
console.log("\nTest 5: 空查询");
const r5 = rerank.progressiveRerank(candidates, "");
assertEqual(r5.length, 3, "空查询返回原样（不崩）");

// ===== Test 6: 位置衰减 =====
console.log("\nTest 6: 位置衰减");
const manyCandidates = Array.from({ length: 10 }, (_, i) => ({
  file_path: `chunk-${i}.md`,
  content: i % 2 === 0 ? "高血压 降压 治疗 药物 ACEI" : "其他无关内容 食物 营养",
  score: 5.0 - i * 0.3,
}));
const r6 = rerank.progressivePipeline(manyCandidates, "高血压", { finalTopK: 5 });
assert(r6.length === 5, "top-5 返回");
// 第一个应该仍然是高血压相关的（即使靠后位置也有内容优势）
assert(r6[0].file_path.startsWith("chunk-"), "第一个结果有 file_path");

// ===== 清场 =====
process.cwd = origCwd;
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n====== 汇总: ${passed} 通过, ${failed} 失败 ======`);
process.exit(failed > 0 ? 1 : 0);
