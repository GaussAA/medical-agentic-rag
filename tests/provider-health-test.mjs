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
const h1 = await ph.runProbe(ph.PROVIDERS[0]);
check("200 → healthy", h1.healthy === true);
check("记录原因 200 OK", h1.reason === "200 OK");

// 2. 不健康探测
console.log("\n[2] runProbe 异常");
mockFetch(async () => ({ ok: false, status: 500 }));
const h2 = await ph.runProbe(ph.PROVIDERS[0]);
check("500 → unhealthy", h2.healthy === false);
check("记录 HTTP 500", h2.reason === "HTTP 500");

// 3. 超时探测
console.log("\n[3] runProbe 超时 (AbortError)");
mockFetch(async () => { throw new Error("This operation was aborted"); });
const h3 = await ph.runProbe(ph.PROVIDERS[0]);
check("超时/异常 → unhealthy", h3.healthy === false);

// 4. 缺 Key 判不健康
console.log("\n[4] 缺 API Key");
delete process.env.DEEPSEEK_API_KEY;
const h4 = await ph.runProbe(ph.PROVIDERS[0]);
check("缺 Key → unhealthy", h4.healthy === false);
check("原因含环境变量名", h4.reason.includes("DEEPSEEK_API_KEY"));

// 5. selectProvider：首个健康者被选中
console.log("\n[5] selectProvider 优先级选择");
mockFetch(async () => ({ ok: true, status: 200 }));
process.env.SENSENOVA_API_KEY = "sk";
// deepseek 无 Key（unhealthy），sensenova 有 Key（healthy）→ 应跳过 deepseek 选 sensenova
const sel = await ph.selectProvider();
check("跳过无 Key 的 primary 选次优先", sel.provider === "sensenova", sel.provider);
check("未降级", sel.degraded === false);

// 6. 全不健康 → 降级回退 priority 最小
console.log("\n[6] 全失败降级");
delete process.env.SENSENOVA_API_KEY;
mockFetch(async () => ({ ok: false, status: 503 }));
const sel2 = await ph.selectProvider();
check("全失败 → degraded=true", sel2.degraded === true);
check("回退 priority 最小(deepseek)", sel2.provider === "deepseek", sel2.provider);

// 7. formatStatus 可读
console.log("\n[7] formatStatus");
const s = ph.formatStatus();
check("含 Provider 标签", s.includes("DeepSeek V4 Flash"));
check("含健康/异常标记", s.includes("✓") || s.includes("✗") || s.includes("·"));

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);

process.chdir(origCwd);
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

const report = { suite: "provider-health", ts: new Date().toISOString(), passed, failed, total: passed + failed, results };
import { writeFileSync, mkdirSync } from "node:fs";
mkdirSync(join(origCwd, "tests"), { recursive: true });
writeFileSync(join(origCwd, "tests", "provider-health-report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log("报告: tests/provider-health-report.json");
process.exit(failed === 0 ? 0 : 1);
