// scripts/ops/smoke-providers.mjs
// 烟雾测试：真实调用各 Provider 的 /v1/models 与轻量 chat completion，验证连通性。
// 用法：node scripts/ops/smoke-providers.mjs
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// 手动加载 .env（避免 process.env 污染）
function loadDotenv() {
  try {
    const text = readFileSync(join(ROOT, ".env"), "utf-8");
    for (const line of text.split("\n")) {
      const m = line.match(/^([A-Z_]+)=["']?(.+?)["']?$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
    }
  } catch { /* no .env */ }
}
loadDotenv();

const TESTS = [
  // P1: sensenova-6.7-flash-lite（聊天）
  { name: "SenseNova 6.7 Flash Lite", provider: "sensenova", model: "sensenova-6.7-flash-lite",
    baseUrl: "https://token.sensenova.cn/v1", key: process.env.SENSENOVA_API_KEY || (process.env.SENSENOVA_API_KEYS || "").split(/[\s,]+/)[0] },
  // P2: sensenova/deepseek 免费通道（聊天）
  { name: "DeepSeek V4 Flash (免费通道)", provider: "sensenova", model: "deepseek-v4-flash",
    baseUrl: "https://token.sensenova.cn/v1", key: process.env.SENSENOVA_API_KEY || (process.env.SENSENOVA_API_KEYS || "").split(/[\s,]+/)[0] },
  // P3: agnes-2.5-flash（聊天）
  { name: "Agnes 2.5 Flash", provider: "agnes", model: "agnes-2.5-flash",
    baseUrl: "https://apihub.agnes-ai.com/v1", key: process.env.AGNES_API_KEY },
  // P4: agnes-2.0-flash（聊天）
  { name: "Agnes 2.0 Flash", provider: "agnes", model: "agnes-2.0-flash",
    baseUrl: "https://apihub.agnes-ai.com/v1", key: process.env.AGNES_API_KEY },
  // 信息图（不是聊天，专有端点）
  { name: "SenseNova U1 Fast (信息图)", provider: "sensenova", model: "sensenova-u1-fast",
    baseUrl: "https://token.sensenova.cn/v1", key: process.env.SENSENOVA_API_KEY || (process.env.SENSENOVA_API_KEYS || "").split(/[\s,]+/)[0],
    imageEndpoint: true },
];

async function testProbe(t) {
  console.log(`\n[${t.name}]`);
  const apiKey = t.key ? t.key.trim() : "";
  if (!apiKey) {
    console.log(`  ✗ 跳过：无 API Key`);
    return { ok: false, reason: "no_key" };
  }

  // 1. /v1/models 端点探测
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${t.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const models = (data.data || data.models || []).map(m => m.id || m.name).join(", ");
      console.log(`  ✓ /v1/models 可达 (${res.status}), 模型: ${models.slice(0, 80)}`);
    } else {
      const text = await res.text().catch(() => "");
      console.log(`  ⚠ /v1/models 返回 ${res.status}: ${text.slice(0, 100)}`);
    }
  } catch (e) {
    console.log(`  ✗ /v1/models 不可达: ${e.message.slice(0, 100)}`);
  }

  // 2. 简单 chat completion（信息图模型不走此路径，跳过）
  if (t.imageEndpoint) {
    console.log(`  ℹ 图像模型不走 chat/completions，跳过聊测`);
    return { ok: null, reason: "image_only" };
  }
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch(`${t.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: t.model,
        messages: [{ role: "user", content: "用三个字回答：好的" }],
        temperature: 0,
        max_tokens: 32,
      }),
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    if (res.ok) {
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content || "(空)";
      console.log(`  ✓ chat/completions 正常: ${content.slice(0, 60)}`);
      return { ok: true };
    } else {
      const text = await res.text().catch(() => "");
      console.log(`  ⚠ chat/completions 返回 ${res.status}: ${text.slice(0, 120)}`);
      return { ok: false, reason: `HTTP ${res.status}` };
    }
  } catch (e) {
    console.log(`  ✗ chat/completions 不可达: ${e.message.slice(0, 100)}`);
    return { ok: false, reason: e.message };
  }
}

console.log("=".repeat(60));
console.log("Provider 连通性烟雾测试（真实 HTTP 调用）");
console.log("=".repeat(60));
let ok = 0, fail = 0, skip = 0;
for (const t of TESTS) {
  const r = await testProbe(t);
  if (r?.ok === true) ok++;
  else if (r?.reason === "no_key") skip++;
  else if (r?.reason === "image_only") skip++;
  else fail++;
}
console.log("\n" + "=".repeat(60));
console.log(`结果：${ok} 可达 / ${fail} 不可达 / ${skip} 跳过`);
console.log("=".repeat(60));
