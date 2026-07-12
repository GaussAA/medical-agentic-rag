// alert-log-test.mjs
// 乙类告警出口单测 —— 验证子系统「自身写失败」告警落 logs/alerts-*.ndjson（不触终端）。
// 原生 node 运行（chdir 到临时目录，避免污染仓库 logs/）。运行：node tests/unit/alert-log-test.mjs

import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(tmpdir(), "alert-test-");
const workdir = mkdtempSync(ROOT);
const origCwd = process.cwd();
process.chdir(workdir); // LOGS_DIR = workdir/logs，隔离仓库

const MOD = pathToFileURL(join(origCwd, ".pi/extensions/lib/alert-log.mjs")).href;
const { alert } = await import(MOD);

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  else { failed++; results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}  ${detail}`); }
}

console.log("\n=== 乙类告警出口单测 ===\n");

// 触发两条乙类告警（正常调用路径：各子系统写失败兜底）
alert("monitor-logger", "日志写入失败: EACCES");
alert("observability", "session_start 日志写入失败: EBADF", { event: "session_start" });

const today = new Date().toISOString().slice(0, 10);
const logPath = join(workdir, "logs", `alerts-${today}.ndjson`);
check("告警日志文件已生成", existsSync(logPath));
const lines = readFileSync(logPath, "utf-8").trim().split("\n").filter(Boolean);
check("写入 2 条告警", lines.length === 2, "got " + lines.length);
const parsed = lines.map((l) => JSON.parse(l));
check("首条 scope/消息正确", parsed[0].scope === "monitor-logger" && parsed[0].message === "日志写入失败: EACCES");
check("级别固定为 alert", parsed.every((p) => p.level === "alert"));
check("次条携带 meta", parsed[1].scope === "observability" && parsed[1].event === "session_start");
check("均带来时间戳 t", parsed.every((p) => typeof p.t === "string" && p.t.includes("T")));

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);

process.chdir(origCwd);
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(join(origCwd, "tests"), { recursive: true });
writeFileSync(
  join(origCwd, "tests", "reports", "alert-log-report.json"),
  JSON.stringify({ suite: "alert-log", ts: new Date().toISOString(), passed, failed, total: passed + failed, results }, null, 2),
  "utf-8",
);
console.log("报告: tests/reports/alert-log-report.json");
process.exit(failed === 0 ? 0 : 1);
