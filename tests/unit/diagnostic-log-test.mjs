// diagnostic-log-test.mjs
// 诊断日志出口单测 —— 验证例程诊断落 logs/diagnostics-*.ndjson（不触终端）。
// 原生 node 运行（chdir 到临时目录，避免污染仓库 logs/）。运行：node tests/unit/diagnostic-log-test.mjs

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(tmpdir(), "diag-test-");
const workdir = mkdtempSync(ROOT);
const origCwd = process.cwd();
process.chdir(workdir); // LOGS_DIR = workdir/logs，隔离仓库

const MOD = pathToFileURL(join(origCwd, ".pi/extensions/lib/diagnostic-log.mjs")).href;
const { diag } = await import(MOD);

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  else { failed++; results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}  ${detail}`); }
}

console.log("\n=== 诊断日志出口单测 ===\n");

// 调用三类诊断
diag.info("scope-a", "信息消息");
diag.warn("scope-b", "告警消息", { k: 1 });
diag.error("scope-c", "错误消息");

const today = new Date().toISOString().slice(0, 10);
const logPath = join(workdir, "logs", `diagnostics-${today}.ndjson`);
check("日志文件已生成", existsSync(logPath));
const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
check("写入 3 条诊断", lines.length === 3, "got " + lines.length);
const parsed = lines.map((l) => JSON.parse(l));
check("info 级别/范围/消息正确", parsed[0].level === "info" && parsed[0].scope === "scope-a" && parsed[0].message === "信息消息");
check("warn 携带 meta", parsed[1].level === "warn" && parsed[1].scope === "scope-b" && parsed[1].k === 1);
check("error 级别正确", parsed[2].level === "error" && parsed[2].scope === "scope-c");
check("均带来时间戳 t", parsed.every((p) => typeof p.t === "string" && p.t.includes("T")));

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);

process.chdir(origCwd);
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(join(origCwd, "tests"), { recursive: true });
writeFileSync(
  join(origCwd, "tests", "reports", "diagnostic-log-report.json"),
  JSON.stringify({ suite: "diagnostic-log", ts: new Date().toISOString(), passed, failed, total: passed + failed, results }, null, 2),
  "utf-8",
);
console.log("报告: tests/reports/diagnostic-log-report.json");
process.exit(failed === 0 ? 0 : 1);
