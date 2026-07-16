// pi-runner-test.mjs
// P1#4 单测 —— 统一 Pi 驱动内核（runPi/stripAnsi/findPiRuntime 导出与纯函数）。
//
// 不真实 spawn Pi（需 KB + proxy + node22 cli）；仅验证模块可导入、ansi 清洗、
// runPi 为可调用函数、findPiRuntime 不抛。真实 spawn/killTree 行为由三处调用点
// （collect-agent-answers / generate-ab-input / agent-driver）原样复用，已语法校验 + import 解析确认。
// 运行: node tests/unit/pi-runner-test.mjs

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // tests/unit
const MOD = pathToFileURL(join(HERE, "..", "..", "scripts", "lib", "pi-runner.mjs")).href;
const { runPi, stripAnsi, findPiRuntime, killTree, toNativePath } = await import(MOD);

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; fails.push(name + (extra ? " :: " + extra : "")); console.error("  ✗", name, extra); }
}

console.log("\n=== P1#4 pi-runner · 驱动内核单测 ===\n");

// 1) 导出存在性（三处调用点赖以 import 的符号）
ok("runPi 为函数", typeof runPi === "function");
ok("stripAnsi 为函数", typeof stripAnsi === "function");
ok("findPiRuntime 为函数", typeof findPiRuntime === "function");
ok("killTree 为函数", typeof killTree === "function");
ok("toNativePath 为函数", typeof toNativePath === "function");

// 2) 纯函数：ANSI 转义清洗（Pi 非交互输出常带终端色码）
ok("stripAnsi 去色码", stripAnsi("\x1b[31m红\x1b[0m") === "红");
ok("stripAnsi 空输入安全", stripAnsi("") === "");
ok("stripAnsi 无码原样", stripAnsi("普通文本") === "普通文本");

// 3) findPiRuntime 不抛（找不到返回 null/对象，绝不崩溃；调用点依赖其不抛）
let rt;
try { rt = findPiRuntime(); ok("findPiRuntime 不抛错", true); }
catch (e) { ok("findPiRuntime 不抛错", false, e.message); }
ok(
  "findPiRuntime 返回 null 或 {node,cli}",
  rt === null || (rt && typeof rt.node === "string" && typeof rt.cli === "string"),
);

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
