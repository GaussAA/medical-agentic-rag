// provider-health-test.mjs
// 故障转移库单测 —— 验证探测/选择/缺 Key 判不健康/全失败降级。
// 原生 node 运行（mock global.fetch），无需 API Key。运行：node tests/provider-health-test.mjs

import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = join(tmpdir(), "ph-test-");
const workdir = mkdtempSync(ROOT);
const origCwd = process.cwd();
process.chdir(workdir);

const MOD = pathToFileURL(join(origCwd, ".pi/extensions/lib/provider-health.mjs")).href;
const ph = await import(MOD);

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  else { failed++; results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}  ${detail}`); }
}

// mock fetch
function mockFetch(handler) { globalThis.fetch = handler; }

console.log("\n=== Provider 故障转移单测 ===\n");

// 1. 健康探测
console.log("[1] runProbe 健康");
mockFetch(async (url) => ({ ok: true, status: 200 }));
process.env.DEEPSEEK_API_KEY = "k1";
const deepseek = ph.PROVIDERS.find((p) => p.provider === "deepseek" && p.model === "deepseek-v4-flash");
const h1 = await ph.runProbe(deepseek);
check("200 → healthy", h1.healthy === true);
check("记录原因 200 OK", h1.reason === "200 OK");

// 2. 不健康探测（冷启动首探即 500 → 信任探针判 unhealthy）
console.log("\n[2] runProbe 异常");
ph.resetHealthState();
mockFetch(async () => ({ ok: false, status: 500 }));
const h2 = await ph.runProbe(deepseek);
check("500 → unhealthy", h2.healthy === false);
check("记录 HTTP 500", h2.reason === "HTTP 500");

// 3. 超时探测（冷启动首探即超时 → 信任探针判 unhealthy）
console.log("\n[3] runProbe 超时 (AbortError)");
ph.resetHealthState();
mockFetch(async () => { throw new Error("This operation was aborted"); });
const h3 = await ph.runProbe(deepseek);
check("超时/异常 → unhealthy", h3.healthy === false);

// 4. 缺 Key 判不健康
console.log("\n[4] 缺 API Key");
ph.resetHealthState();
delete process.env.DEEPSEEK_API_KEY;
const h4 = await ph.runProbe(deepseek);
check("缺 Key → unhealthy", h4.healthy === false);
check("原因含环境变量名", h4.reason.includes("DEEPSEEK_API_KEY"));

// 5. selectProvider：首个健康者被选中
console.log("\n[5] selectProvider 优先级选择");
ph.resetHealthState();
mockFetch(async () => ({ ok: true, status: 200 }));
process.env.SENSENOVA_API_KEY = "sk";
// local 无 Key 但 authEnv=null（无需 Key），priority 0 居首 → 选 local
const sel = await ph.selectProvider();
check("无 Key 本地 provider 优先（priority 0）", sel.provider === "local", sel.provider);
check("未降级", sel.degraded === false);

// 6. 全不健康 → 降级回退 priority 最小
console.log("\n[6] 全失败降级");
ph.resetHealthState();
delete process.env.SENSENOVA_API_KEY;
mockFetch(async () => ({ ok: false, status: 503 }));
const sel2 = await ph.selectProvider();
check("全失败 → degraded=true", sel2.degraded === true);
check("回退 priority 最小(local 本地优先)", sel2.provider === "local", sel2.provider);

// 7. formatStatus 可读
console.log("\n[7] formatStatus");
const s = ph.formatStatus();
check("含 Provider 标签", s.includes("DeepSeek V4 Flash"));
check("含健康/异常标记", s.includes("✓") || s.includes("✗") || s.includes("·"));

// 8. 滞后逻辑（hysteresis）：健康基线下的单次抖动不翻转，连续两次才翻转
console.log("\n[8] 滞后逻辑（hysteresis）");
ph.resetHealthState();
process.env.DEEPSEEK_API_KEY = "k1"; // 恢复 Key（[4] 已删），本用例需健康基线
mockFetch(async () => ({ ok: true, status: 200 }));
const b1 = await ph.runProbe(deepseek);
check("基线首探健康 → healthy", b1.healthy === true);
const b2 = await ph.runProbe(deepseek);
check("连续健康 → 仍 healthy", b2.healthy === true);
mockFetch(async () => { throw new Error("This operation was aborted"); });
const j1 = await ph.runProbe(deepseek);
check("单次超时抖动 → 仍 healthy（滞后吸收）", j1.healthy === true);
const j2 = await ph.runProbe(deepseek);
check("连续两次超时 → unhealthy（滞后翻转）", j2.healthy === false);

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);

process.chdir(origCwd);
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

const report = { suite: "provider-health", ts: new Date().toISOString(), passed, failed, total: passed + failed, results };
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(join(origCwd, "tests"), { recursive: true });
writeFileSync(join(origCwd, "tests", "reports", "provider-health-report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log("报告: tests/reports/provider-health-report.json");
process.exit(failed === 0 ? 0 : 1);
