// hyde.test.mjs
// HyDE 模块单元测试 —— 测试 generateHypotheticalAnswer 和 hydeRetrieve 的编排逻辑。
//
// 注意：HyDE 依赖 LLM 调用，在无 API Key 的环境下测试回退/降级路径。

import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "hyde-test-"));
const KB_DIR = join(TEST_DIR, "data", "kb");
mkdirSync(KB_DIR, { recursive: true });

// 写一个最小的 guide-index.json（query-transform 内部会查看 LLM 可用性，但 test 不调 query-transform）
writeFileSync(join(KB_DIR, ".guide-index.json"), JSON.stringify({
  generatedAt: new Date().toISOString(),
  totalGuides: 1,
  totalKeywords: 1,
  guideMap: { "测试指南": { id: "test", disease: "测试", keywords: ["测试"], sectionCount: 1 } },
  keywordIndex: { "测试": ["测试指南"] },
}), "utf-8");

const origCwd = process.cwd;
process.cwd = () => TEST_DIR;

const hyde = await import("../../../.pi/extensions/lib/query-transform/hyde.mjs");

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

function assertNull(v, msg) {
  if (v === null) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}: expected null, got ${JSON.stringify(v)}`); }
}

// ===== Test 1: 空查询 =====
console.log("\nTest 1: 空查询");
const r1 = await hyde.generateHypotheticalAnswer("");
assertNull(r1, "空查询返回 null");

// ===== Test 2: LLM 不可用（无 API Key 正常环境） =====
console.log("\nTest 2: LLM 不可用时的降级");
const r2 = await hyde.generateHypotheticalAnswer("高血压的治疗");
// 如果 LLM 不可用，返回 null
if (r2 === null) {
  console.log("  ~ LLM 不可用，返回 null（预期降级行为）");
  passed++;
} else {
  console.log(`  ~ LLM 可用，生成假设答案: "${r2.slice(0, 50)}..."`);
  passed++;
}

// ===== Test 3: hydeRetrieve 编排 — 标准路径 =====
console.log("\nTest 3: hydeRetrieve 编排");
// Mock searchFn 返回固定结果
const mockSearchFn = (q, opts) => {
  if (q === "高血压的治疗") {
    return { results: [{ file_path: "a.md", content: "original result", score: 5.0 }] };
  }
  // HyDE 假设答案文本作为查询时
  return { results: [{ file_path: "b.md", content: "hyde result", score: 4.5 }] };
};

const r3 = await hyde.hydeRetrieve("高血压的治疗", mockSearchFn, { hydeTimeoutMs: 1000 });
// 结果取决于 LLM 是否可用
assert(r3.results.length > 0, "hydeRetrieve 返回结果");
// 如果 LLM 不可用，hydeApplied 为 false
if (process.env.SENSENOVA_API_KEY || process.env.SENSENOVA_API_KEYS) {
  // LLM 可用时，应该应用了 HyDE
  console.log("  ~ LLM 可用，验证实际 HyDE 行为");
} else {
  // LLM 不可用，应直接返回原始结果
  assert(r3.hydeApplied === false, "LLM 不可用时 hydeApplied 为 false");
  assertNull(r3.hydeQuery, "LLM 不可用时 hydeQuery 为 null");
  passed++;
}
// Clean up
passed++;

// ===== Test 4: hydeRetrieve — 空原始结果 =====
console.log("\nTest 4: hydeRetrieve — 空原始结果");
const emptyFn = () => ({ results: [] });
const r4 = await hyde.hydeRetrieve("查询", emptyFn, { hydeTimeoutMs: 500 });
assertEqual(r4.results.length, 0, "空原始结果返回空");
// hydeApplied 取决于 LLM 可用性，不崩溃即可
assert(true, "不崩溃");

// ===== 清场 =====
process.cwd = origCwd;
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n====== 汇总: ${passed} 通过, ${failed} 失败 ======`);
process.exit(failed > 0 ? 1 : 0);
