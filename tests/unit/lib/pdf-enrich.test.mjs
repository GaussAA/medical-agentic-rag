// pdf-enrich.test.mjs
// PDF 增强管道单元测试 —— 测试 Python 桥接的质量检测与表格提取。

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PY_SCRIPT = join(ROOT, "scripts", "kb", "enrich", "_pdf_enrich.py");
const RAW_DIR = join(ROOT, "data", "raw");
const PYTHON = process.env.PYTHON_PATH || "python";

let passed = 0, failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

function assertEqual(a, b, msg) {
  if (a === b) { passed++; console.log(`  ✓ ${msg} (${JSON.stringify(a)})`); }
  else { failed++; console.error(`  ✗ ${msg}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`); }
}

// ===== Test 1: Python 脚本是否存在 =====
console.log("\nTest 1: Python 脚本存在");
assert(existsSync(PY_SCRIPT), `Python 桥接脚本存在: ${PY_SCRIPT}`);

// ===== Test 2: 质量检测 — 已知 PDF =====
console.log("\nTest 2: 质量检测（已知 PDF）");
const testPdf = join(RAW_DIR, "1.2026年国家医疗质量安全改进目标.pdf");
if (existsSync(testPdf)) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(PYTHON, [PY_SCRIPT, testPdf, "--check-quality"], {
    encoding: "utf-8", timeout: 15000,
  });
  assert(r.status === 0, "Python 脚本正常退出");
  if (r.status === 0) {
    const data = JSON.parse(r.stdout);
    assert(data.quality !== undefined, "返回 quality 字段");
    assert(typeof data.quality.total_chars === "number", "total_chars 是数字");
    assert(typeof data.quality.cjk_ratio === "number", "cjk_ratio 是数字");
    assert(data.quality.total_chars > 0, "字符数 > 0");
    assert(data.quality.low_quality === false, "该 PDF 非低质量（pdftotext 可处理）");
    console.log(`    字符=${data.quality.total_chars} CJK=${(data.quality.cjk_ratio * 100).toFixed(0)}%`);
  }
} else {
  console.log("  ~ 测试 PDF 不存在，跳过");
  passed++;
}

// ===== Test 3: 表格提取 — 有表格的 PDF =====
console.log("\nTest 3: 表格提取");
const tablePdf = join(RAW_DIR, "2.2026年各专业质控工作改进目标.pdf");
if (existsSync(tablePdf)) {
  const { spawnSync } = await import("node:child_process");
  const r = spawnSync(PYTHON, [PY_SCRIPT, tablePdf, "--tables"], {
    encoding: "utf-8", timeout: 30000,
  });
  assert(r.status === 0, "Python 脚本正常退出");
  if (r.status === 0) {
    const data = JSON.parse(r.stdout);
    assert(Array.isArray(data.tables), "返回 tables 数组");
    console.log(`    表格数: ${data.table_count}`);
    if (data.table_count > 0) {
      const first = data.tables[0];
      assert(first.text.length > 0, "第一个表格有文本内容");
      assert(first.rows > 0, "表格有行");
      assert(first.cols > 0, "表格有列");
    }
  }
} else {
  console.log("  ~ 表格 PDF 不存在，跳过");
  passed++;
}

// ===== Test 4: Node.js CLI 帮助 =====
console.log("\nTest 4: Node.js CLI 帮助");
const { spawnSync } = await import("node:child_process");
const cliPath = join(ROOT, "scripts", "kb", "enrich", "pdf-enrich.mjs");
const helpResult = spawnSync("node", [cliPath], { encoding: "utf-8", timeout: 5000 });
assert(helpResult.status === 0, "帮助信息正常显示");
assert(helpResult.stdout.includes("PDF 增强管道"), "帮助包含标题");
assert(helpResult.stdout.includes("--batch"), "帮助包含 --batch");

// ===== Test 5: Python 桥接 — 不存在的文件 =====
console.log("\nTest 5: Python 桥接 — 不存在的文件");
const r5 = spawnSync(PYTHON, [PY_SCRIPT, "/nonexistent/file.pdf", "--check-quality"], {
  encoding: "utf-8", timeout: 5000,
});
assert(r5.status !== 0, "不存在的文件返回非零");

console.log(`\n====== 汇总: ${passed} 通过, ${failed} 失败 ======`);
process.exit(failed > 0 ? 1 : 0);
