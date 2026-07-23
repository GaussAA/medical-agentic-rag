// kb-tags.test.mjs
// 标签系统单元测试 —— 测试 kb-sources.mjs 中的 addTags/removeTag/listAllTags/queryByTag

import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TEST_DIR = mkdtempSync(join(tmpdir(), "kb-tags-test-"));
const KB_DIR = join(TEST_DIR, "data", "kb");
const RAW_DIR = join(TEST_DIR, "data", "raw");

mkdirSync(KB_DIR, { recursive: true });
mkdirSync(RAW_DIR, { recursive: true });

// 创建测试 registry
writeFileSync(join(KB_DIR, "kb-sources.json"), JSON.stringify({
  sources: [
    {
      id: "test-1",
      name: "高血压指南(2024版)",
      type: "local",
      localPath: "raw\\test-1.pdf",
      department: "心血管",
      tags: ["高血压", "慢病"],
    },
    {
      id: "test-2",
      name: "糖尿病指南(2023年版)",
      type: "local",
      localPath: "raw\\test-2.pdf",
      department: "内分泌",
      tags: ["糖尿病", "慢病"],
    },
    {
      id: "test-3",
      name: "骨折诊疗规范",
      type: "local",
      localPath: "raw\\test-3.pdf",
      department: "外科/综合",
      tags: [],
    },
  ],
}), "utf-8");

// 模拟 process.cwd
const origCwd = process.cwd;
process.cwd = () => TEST_DIR;

const kb = await import("../../../.pi/extensions/lib/kb-sources.mjs");

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

// ===== Test 1: addTags =====
console.log("\nTest 1: addTags — 添加标签");

const r1 = kb.addTags("test-3", "骨科");
assert(r1.ok === true, "addTags 成功");
assertEqual(r1.entry.tags, ["骨科"], "test-3 标签为 ['骨科']");

const reg = JSON.parse(readFileSync(join(KB_DIR, "kb-sources.json"), "utf-8"));
const t3 = reg.sources.find(s => s.id === "test-3");
assertEqual(t3.tags, ["骨科"], "registry 中 test-3 标签已持久化");

// ===== Test 2: addTags 去重 =====
console.log("\nTest 2: addTags — 去重");
const r2 = kb.addTags("test-3", "骨科", "骨科", "骨折");
assert(r2.ok === true, "addTags 去重成功");
assertEqual(r2.entry.tags, ["骨科", "骨折"], "test-3 标签为 ['骨科', '骨折']");

// ===== Test 3: addTags 不存在的来源 =====
console.log("\nTest 3: addTags — 不存在的来源");
const r3 = kb.addTags("nonexistent", "标签");
assert(r3.ok === false, "不存在的来源返回 error");

// ===== Test 4: listAllTags =====
console.log("\nTest 4: listAllTags — 全库标签");
const tags = kb.listAllTags();
assert(tags.length >= 3, `至少 3 个不同标签 (实际 ${tags.length})`);

const slowTag = tags.find(t => t.tag === "慢病");
assert(slowTag !== undefined, "有 '慢病' 标签");
assertEqual(slowTag.count, 2, "'慢病' 覆盖 2 个来源");

const gukeTag = tags.find(t => t.tag === "骨科");
assert(gukeTag !== undefined, "有 '骨科' 标签");
assertEqual(gukeTag.count, 1, "'骨科' 覆盖 1 个来源");

// ===== Test 5: queryByTag =====
console.log("\nTest 5: queryByTag — 按标签查询");
const q1 = kb.queryByTag("慢病");
assertEqual(q1.length, 2, "'慢病' 查到 2 个来源");
assertEqual(q1[0].department, "心血管", "第一个来源的专科为 '心血管'");

const q2 = kb.queryByTag("高血压");
assertEqual(q2.length, 1, "'高血压' 查到 1 个来源");
assertEqual(q2[0].id, "test-1", "来源 ID 为 test-1");

const q3 = kb.queryByTag("不存在的标签");
assertEqual(q3.length, 0, "不存在的标签返回空");

// ===== Test 6: removeTag =====
console.log("\nTest 6: removeTag — 移除标签");
const r6 = kb.removeTag("test-3", "骨科");
assert(r6.ok === true, "removeTag 成功");
assertEqual(r6.entry.tags, ["骨折"], "test-3 仅剩 '骨折'");

const r6b = kb.removeTag("test-3", "骨折");
assert(r6b.ok === true, "再次 removeTag 成功");
assertEqual(r6b.entry.tags, [], "test-3 标签为空");

// ===== Test 7: removeTag 不存在的标签 =====
console.log("\nTest 7: removeTag — 不存在的标签");
const r7 = kb.removeTag("test-3", "不存在");
assert(r7.ok === false, "不存在的标签返回 error");

// ===== Test 8: removeTag 不存在的来源 =====
console.log("\nTest 8: removeTag — 不存在的来源");
const r8 = kb.removeTag("nonexistent", "标签");
assert(r8.ok === false, "不存在的来源返回 error");

// ===== 清场 =====
process.cwd = origCwd;
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n====== 汇总: ${passed} 通过, ${failed} 失败 ======`);
process.exit(failed > 0 ? 1 : 0);
