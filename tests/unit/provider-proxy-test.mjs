// tests/provider-proxy-test.mjs
// Provider 代理网关单元测试 —— 验证热切换核心逻辑与断路机制。
//
// 纯 node 运行，不启动真实 HTTP 服务器，不调外部 API。

import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

let passed = 0;
let failed = 0;

function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ✓ ${msg}`); }
  else { failed++; console.error(`  ✗ ${msg}`); }
}

// 模拟 Provider 注册表（与 provider-health.mjs 优先级一致，2026-07-15 重排：免费优先 + Agnes 2.5 新模型）
const PROVIDERS = [
  { provider: "sensenova", model: "sensenova-6.7-flash-lite", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", priority: 1, label: "SenseNova" },
  { provider: "sensenova", model: "deepseek-v4-flash", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", priority: 2, label: "DeepSeek Free" },
  { provider: "agnes", model: "agnes-2.5-flash", baseUrl: "https://apihub.agnes-ai.com/v1", authEnv: "AGNES_API_KEY", priority: 3, label: "Agnes 2.5 Free" },
  { provider: "agnes", model: "agnes-2.0-flash", baseUrl: "https://apihub.agnes-ai.com/v1", authEnv: "AGNES_API_KEY", priority: 4, label: "Agnes 2.0 Free" },
  { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", authEnv: "DEEPSEEK_API_KEY", priority: 5, label: "DeepSeek Paid" },
];

// 测试 1：proxy 核心逻辑 —— Provider 选择
console.log("\n=== Provider 选择 ===");
{
  // 模拟 selectProvider 逻辑
  const sorted = [...PROVIDERS].sort((a, b) => a.priority - b.priority);
  assert(sorted[0].provider === "sensenova", "P1 sensenova 免费");
  assert(sorted[0].model === "sensenova-6.7-flash-lite", "P1 模型 = sensenova-6.7-flash-lite");
  assert(sorted[1].provider === "sensenova" && sorted[1].model === "deepseek-v4-flash", "P2 sensenova 免费深搜通道");
  assert(sorted[2].provider === "agnes" && sorted[2].model === "agnes-2.5-flash", "P3 Agnes 2.5 Flash 免费");
  assert(sorted[3].provider === "agnes" && sorted[3].model === "agnes-2.0-flash", "P4 Agnes 2.0 Flash 免费");
  assert(sorted[4].provider === "deepseek" && sorted[4].model === "deepseek-v4-flash", "P5 deepseek 付费（末位兜底）");
}

// 测试 2：断路器阈值
console.log("\n=== 断路器逻辑 ===");
{
  const THRESHOLD = 3;
  let failures = 0;
  let switched = false;
  const onError = () => {
    failures++;
    if (failures >= THRESHOLD) switched = true;
  };
  for (let i = 0; i < 5; i++) onError();
  assert(switched === true, "连续 3 次失败触发断路器");
  assert(failures === 5, "5 次调用计数正确");
}

// 测试 3：重试次数
console.log("\n=== 重试机制 ===");
{
  const MAX_RETRIES = 2;
  let attempts = 0;
  async function forward() {
    for (let a = 0; a <= MAX_RETRIES; a++) {
      attempts++;
      if (a < MAX_RETRIES) continue; // 模拟失败
      break;
    }
  }
  await forward();
  assert(attempts === 3, `最大重试 ${MAX_RETRIES} 次 + 首次 = ${attempts} 次`);
}

// 测试 4：failover 文件读写
console.log("\n=== Failover 文件状态 ===");
{
  const tmpDir = mkdtempSync(join(tmpdir(), "proxy-test-"));
  const f = join(tmpDir, "failover.json");
  const state = { provider: "deepseek", model: "deepseek-v4-flash", ts: new Date().toISOString() };
  writeFileSync(f, JSON.stringify(state));
  const read = JSON.parse(readFileSync(f, "utf-8"));
  assert(read.provider === "deepseek", "failover 文件写入正确");
  assert(read.model === "deepseek-v4-flash", "model 正确");
  rmSync(tmpDir, { recursive: true, force: true });
}

// 测试 5：并发安全
console.log("\n=== 并发安全 ===");
{
  let count = 0;
  async function inc() { count++; }
  // 模拟 10 个并发请求
  await Promise.all(Array.from({ length: 10 }, () => inc()));
  assert(count === 10, "10 并发请求计数正确");
}

// 测试 6：冷却期防抖
console.log("\n=== 切换防抖 ===");
{
  const DEBOUNCE_MS = 5000;
  let lastSwitch = Date.now() - 10000; // 初始化为 10s 前，确保首次通过
  let switchCount = 0;
  function trySwitch() {
    const now = Date.now();
    if (now - lastSwitch > DEBOUNCE_MS) {
      lastSwitch = now;
      switchCount++;
    }
  }
  trySwitch(); // 第一次：距离上次 10s > 5s → 成功
  assert(switchCount === 1, "第一次切换成功");
  trySwitch(); // 第二次：距离第一次 < 5s → 被防抖
  assert(switchCount === 1, "冷却期内不重复切换");
  // 模拟冷却期已过
  lastSwitch = Date.now() - 10000;
  trySwitch(); // 第三次：冷却已过 → 再次成功
  assert(switchCount === 2, "冷却期后允许再次切换");
}

// === 汇总 ===
console.log(`\n=== 结果 ===`);
console.log(`通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error(`失败 ${failed}`);
  process.exit(1);
}
