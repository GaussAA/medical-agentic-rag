// check-recall-regression.test.mjs
// 召回率回归检测单元测试

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "recall-test-"));
const KB_DIR = join(TEST_DIR, "data", "kb");
const REPORTS_DIR = join(TEST_DIR, "tests", "reports");
const GOLD_PATH = join(TEST_DIR, "tests", "gold-answers.json");

mkdirSync(KB_DIR, { recursive: true });
mkdirSync(REPORTS_DIR, { recursive: true });
mkdirSync(join(TEST_DIR, "tests"), { recursive: true });

// 写一个最小 guide-index.json
writeFileSync(join(KB_DIR, ".guide-index.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalGuides: 2,
  totalKeywords: 4,
  guideMap: {
    "高血压指南(2024版)": { id: "g1", disease: "高血压", keywords: ["高血压", "血压"], sectionCount: 5 },
    "糖尿病指南(2023版)": { id: "g2", disease: "糖尿病", keywords: ["糖尿病", "血糖"], sectionCount: 5 },
  },
  keywordIndex: { "高血压": ["高血压指南(2024版)"], "糖尿病": ["糖尿病指南(2023版)"] },
}), "utf-8");

// 写一个最小 gold-answers.json
writeFileSync(GOLD_PATH, JSON.stringify({
  items: [
    {
      id: "Q01",
      q: "高血压的治疗",
      gtSources: ["高血压指南(2024版)"],
    },
    {
      id: "Q02",
      q: "糖尿病的诊断",
      gtSources: ["糖尿病指南(2023版)"],
    },
    {
      id: "Q03",
      q: "骨质疏松的预防",
      gtSources: ["骨质疏松指南(2022版)"],  // 不存在的指南 → 预期 miss
    },
  ],
}), "utf-8");

// 构建测试用的合成索引
const testIndex = {
  guideMap: {
    "高血压指南(2024版)": { id: "g1", disease: "高血压", keywords: ["高血压", "血压"], sectionCount: 5 },
    "糖尿病指南(2023版)": { id: "g2", disease: "糖尿病", keywords: ["糖尿病", "血糖"], sectionCount: 5 },
  },
  keywordIndex: { "高血压": ["高血压指南(2024版)"], "糖尿病": ["糖尿病指南(2023版)"] },
  totalGuides: 2,
  totalKeywords: 4,
  generatedAt: new Date().toISOString(),
  _idf: new Map(),
  _gtok: new Map(),
};

const origCwd = process.cwd;
process.cwd = () => TEST_DIR;

const mod = await import("../../../scripts/ci/check-recall-regression.mjs");

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertClose(a, b, tol, msg) {
  if (Math.abs(a - b) <= tol) { passed++; console.log(`  ✓ ${msg} (${a})`); }
  else { failed++; console.error(`  ✗ ${msg}: ${a} not close to ${b} (±${tol})`); }
}

// ===== Test 1: measureRecall 基本功能 =====
console.log("\nTest 1: measureRecall");
const r1 = mod.measureRecall({ topK: 3, index: testIndex, goldFile: GOLD_PATH });
assert(r1.totalQuestions === 3, "3 个问题");
assert(r1.totalSources === 3, "3 个引用源");
assertClose(r1.recall, 2 / 3, 0.01, "2/3 命中");
assert(r1.misses.length === 1, "1 个 miss（骨质疏松）");
assert(r1.perQuestion.length === 3, "3 条逐题记录");

// ===== Test 2: TopK 变化 =====
console.log("\nTest 2: TopK=1");
const r2 = mod.measureRecall({ topK: 1, index: testIndex, goldFile: GOLD_PATH });
assert(r2.topK === 1, "topK=1");
assert(r2.hits <= r1.hits, "更严格的 topK 命中数不增");

// ===== Test 3: 基线保存与读取 =====
console.log("\nTest 3: 基线保存与对比");
const baselinePath = join(REPORTS_DIR, "recall-baseline.json");
writeFileSync(baselinePath, JSON.stringify({
  generatedAt: "2026-01-01T00:00:00.000Z",
  recall: 0.5,
  topK: 3,
  totalQuestions: 3,
}), "utf-8");

const r3 = mod.measureRecall({ topK: 3, index: testIndex, goldFile: GOLD_PATH });
assertClose(r3.recall, 2 / 3, 0.01, "当前 recall 仍为 0.667");

// ===== 清场 =====
process.cwd = origCwd;
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n====== 汇总: ${passed} 通过, ${failed} 失败 ======`);
process.exit(failed > 0 ? 1 : 0);
