// kb-recycle.test.mjs
// 回收站功能单元测试 —— 纯函数验证，不依赖 Pi 运行时。

import { randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// 模拟原模块导出的函数，用临时目录
const TEST_DIR = mkdtempSync(join(tmpdir(), "kbrecycle-test-"));
const RAW_DIR = join(TEST_DIR, "data", "raw");
const RAW_TXT_DIR = join(TEST_DIR, "data", "raw-txt");
const KB_DIR = join(TEST_DIR, "data", "kb");
const RECYCLE_DIR = join(TEST_DIR, ".pi", "recycle");

// 先建目录
mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(RAW_TXT_DIR, { recursive: true });
mkdirSync(KB_DIR, { recursive: true });
mkdirSync(RECYCLE_DIR, { recursive: true });

// 创建临时桩文件
writeFileSync(join(RAW_DIR, "test-guide.pdf"), "fake-pdf-content", "utf-8");
writeFileSync(join(RAW_TXT_DIR, "test-guide.txt"), "fake-txt-content", "utf-8");

// 创建 registry 桩
const testRegistry = {
  sources: [
    {
      id: "test-guide",
      name: "测试指南(2024版)",
      type: "local",
      localPath: "raw/test-guide.pdf",
      cadenceDays: 30,
      validate: "sha256",
      department: "测试内科",
      lastChecked: "2026-07-20T00:00:00.000Z",
      lastHash: "abc123",
      note: "测试用",
    },
    {
      id: "another-guide",
      name: "另一份指南(2025年版)",
      type: "local",
      localPath: "raw/another-guide.pdf",
      cadenceDays: 30,
      validate: "sha256",
      department: "测试内科",
      lastChecked: "2026-07-21T00:00:00.000Z",
      lastHash: "def456",
      note: "测试用（应保留）",
    },
  ],
};
writeFileSync(join(KB_DIR, "kb-sources.json"), JSON.stringify(testRegistry, null, 2), "utf-8");

// 修改 kb-recycle.mjs 中用到的路径常量通过环境变量覆盖。
// 由于模块是 import 的，不能用 env hack。这里我们直接调用 exported 函数测逻辑，
// 用 monkey-patch 覆盖文件路径。
// 实际上，因为 kb-recycle.mjs 中的路径是硬编码的 process.cwd()，我们需要
// 在测试中修改 cwd 到 TEST_DIR。
// 但 process.chdir 在 Node 中允许。
const origCwd = process.cwd;
process.cwd = () => TEST_DIR;

// 动态导入
const recycle = await import("../../../.pi/extensions/lib/kb-recycle.mjs");

let failed = 0;
let passed = 0;

function assert(cond, msg) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${msg}`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}

function assertEqual(a, b, msg) {
  if (a === b) {
    passed++;
    console.log(`  ✓ ${msg} (${JSON.stringify(a)})`);
  } else {
    failed++;
    console.error(`  ✗ ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
  }
}

// ===== Test 1: remove test-guide =====
console.log("\nTest 1: removeFromRegistry — 删除 test-guide");
const r1 = recycle.removeFromRegistry("test-guide");
assert(r1.ok === true, "remove 成功");
assertEqual(r1.entry.sourceId, "test-guide", "sourceId 正确");
assertEqual(r1.entry.movedFiles.length, 2, "移动 2 个文件（raw + raw-txt）");

// 验证 registry 已更新
const regAfter = JSON.parse(readFileSync(join(KB_DIR, "kb-sources.json"), "utf-8"));
assertEqual(regAfter.sources.length, 1, "registry 仅剩 1 条");
assertEqual(regAfter.sources[0].id, "another-guide", "保留的是 another-guide");

// 验证文件已移动
const discardDir = join(RAW_DIR, "_discarded", "test-guide");
assert(existsSync(discardDir), "_discarded/test-guide/ 目录存在");
assert(existsSync(join(discardDir, "test-guide.pdf")), "pdf 已移入废弃目录");
assert(existsSync(join(discardDir, "test-guide.txt")), "txt 已移入废弃目录");

// 验证原文件已消失
assert(!existsSync(join(RAW_DIR, "test-guide.pdf")), "原始 pdf 已移除");
assert(!existsSync(join(RAW_TXT_DIR, "test-guide.txt")), "原始 txt 已移除");

// ===== Test 2: listRecycle =====
console.log("\nTest 2: listRecycle — 查看回收站");
const list = recycle.listRecycle({ includeExpired: true });
assertEqual(list.length, 1, "回收站 1 条");
assertEqual(list[0].sourceId, "test-guide", "条目是 test-guide");

// ===== Test 3: getRecycleStats =====
console.log("\nTest 3: getRecycleStats — 回收站统计");
const stats = recycle.getRecycleStats();
assertEqual(stats.total, 1, "总数 1");
assertEqual(stats.expiredCount, 0, "未过期（刚删）");

// ===== Test 4: restoreFromRecycle =====
console.log("\nTest 4: restoreFromRecycle — 恢复 test-guide");
const r4 = recycle.restoreFromRecycle(list[0].id);
assert(r4.ok === true, "恢复成功");
assertEqual(r4.entry.sourceId, "test-guide", "恢复的是 test-guide");

// 验证 registry 已恢复
const regAfterRestore = JSON.parse(readFileSync(join(KB_DIR, "kb-sources.json"), "utf-8"));
assertEqual(regAfterRestore.sources.length, 2, "registry 恢复为 2 条");
assertEqual(regAfterRestore.sources[1].id, "test-guide", "test-guide 已恢复");

// 验证文件已恢复
assert(existsSync(join(RAW_DIR, "test-guide.pdf")), "pdf 已恢复");
assert(existsSync(join(RAW_TXT_DIR, "test-guide.txt")), "txt 已恢复");

// 验证回收站已清空
const listAfter = recycle.listRecycle({ includeExpired: true });
assertEqual(listAfter.length, 0, "回收站已空");

// ===== Test 5: purgeExpired — 模拟过期 =====
console.log("\nTest 5: purgeExpired — 过期清理");
// 先删一次让回收站有数据
recycle.removeFromRegistry("test-guide");
// 篡改 removedAt 为 40 天前（直接改文件）
const manifest = JSON.parse(readFileSync(join(RECYCLE_DIR, "kb-recycle.json"), "utf-8"));
const oldDate = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
manifest.entries[0].removedAt = oldDate;
writeFileSync(join(RECYCLE_DIR, "kb-recycle.json"), JSON.stringify(manifest, null, 2), "utf-8");

const purgeResult = recycle.purgeExpired();
assertEqual(purgeResult.purged, 1, "清理 1 条过期条目");

// 验证丢弃目录已删除
assert(!existsSync(join(RAW_DIR, "_discarded", "test-guide")), "过期废弃目录已删除");

// 验证回收站已空
const listAfterPurge = recycle.listRecycle({ includeExpired: true });
assertEqual(listAfterPurge.length, 0, "回收站过期后全空");

// 验证 registry 另一条还在
const finalReg = JSON.parse(readFileSync(join(KB_DIR, "kb-sources.json"), "utf-8"));
assertEqual(finalReg.sources.length, 1, "another-guide 保留");

// ===== Test 6: 删除不存在的来源 =====
console.log("\nTest 6: removeFromRegistry — 不存在的 id");
const r6 = recycle.removeFromRegistry("non-existent-id");
assert(r6.ok === false, "删除不存在的源返回 error");
assert(r6.error.includes("未找到"), "error 信息正确");

// ===== 清场 =====
process.cwd = origCwd;
rmSync(TEST_DIR, { recursive: true, force: true });

console.log(`\n====== 汇总: ${passed} 通过, ${failed} 失败 ======`);
process.exit(failed > 0 ? 1 : 0);
