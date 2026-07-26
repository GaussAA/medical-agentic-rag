// llm-judge/client.mjs — 免费优先 LLM 客户端 + 并发执行器

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

function loadEnv() {
  if (process.env.SENSENOVA_API_KEYS && process.env.DEEPSEEK_API_KEY) return;
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      join(here, "..", "..", "..", "..", ".env"),
      join(here, "..", "..", "..", ".env"),
      join(process.cwd(), ".env"),
    ];
    const envPath = candidates.find((p) => { try { readFileSync(p, "utf-8"); return true; } catch { return false; } });
    if (!envPath) return;
    const text = readFileSync(envPath, "utf-8");
    for (const raw of text.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (process.env[key] === undefined) process.env[key] = val;
    }
  } catch { /* 静默 */ }
}
loadEnv();

const SENSENOVA_URL = process.env.SENSENOVA_PROXY_URL || "https://token.sensenova.cn/v1/chat/completions";
const SENSENOVA_MODEL = "sensenova-6.7-flash-lite";
const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";
const DEEPSEEK_MODEL = "deepseek-v4-flash";
// ── 评测用模型（独立于生成模型，零成本升级方案）──
// LLM_JUDGE_MODEL 可选值：
//   "sensenova-6.7-flash-lite"       — sensenova 自有模型（默认，免费）
//   "sensenova/deepseek-v4-flash"    — deepseek 经 sensenova 通道（免费，限流）
//   "agnes/agnes-2.0-flash"          — Agnes 2.0 Flash（免费）
// 详见 provider-proxy.mjs 的 Chain 配置。
const JUDGE_MODEL = process.env.LLM_JUDGE_MODEL || "sensenova-6.7-flash-lite";
const AGNES_URL = "https://apihub.agnes-ai.com/v1/chat/completions";
const AGNES_MODEL = "agnes-2.0-flash";
const MAX_CONCURRENCY = 20;

function parseKeys(raw) {
  if (!raw) return [];
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

const SENSENOVA_KEYS = parseKeys(process.env.SENSENOVA_API_KEYS || process.env.SENSENOVA_API_KEY || "");
if (process.env.SENSENOVA_API_KEY && !SENSENOVA_KEYS.includes(process.env.SENSENOVA_API_KEY)) {
  SENSENOVA_KEYS.push(process.env.SENSENOVA_API_KEY);
}

function sensenovaEndpoints() {
  return SENSENOVA_KEYS.map((key) => ({ name: "SenseNova 6.7 Flash Lite", url: SENSENOVA_URL, model: SENSENOVA_MODEL, key }));
}

// 评测专用端点（根据 JUDGE_MODEL 自动选择）
// 返回端点数组或空数组（使用默认模型）
function judgeEndpoints() {
  // Agnes 2.0 Flash（免费）
  if (JUDGE_MODEL === "agnes/agnes-2.0-flash" && process.env.AGNES_API_KEY) {
    return [{ name: "Agnes 2.0 Flash", url: AGNES_URL, model: AGNES_MODEL, key: process.env.AGNES_API_KEY }];
  }
  // DeepSeek V4 Flash 经 sensenova 免费通道（免费，限流）
  if (JUDGE_MODEL === "sensenova/deepseek-v4-flash" && SENSENOVA_KEYS.length > 0) {
    return SENSENOVA_KEYS.map((key) => ({ name: "DeepSeek V4 Flash(免费通道)", url: SENSENOVA_URL, model: "deepseek-v4-flash", key }));
  }
  // 默认：使用 sensenova-6.7-flash-lite
  return [];
}

function deepseekEndpoint() {
  return process.env.DEEPSEEK_API_KEY ? { name: "DeepSeek V4 Flash (兜底)", url: DEEPSEEK_URL, model: DEEPSEEK_MODEL, key: process.env.DEEPSEEK_API_KEY } : null;
}

const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY) || 20;
export const SENSENOVA_CONCURRENCY = Math.max(1, Math.min(LLM_CONCURRENCY, 20));
const ALLOW_PAID = process.env.ALLOW_PAID_FALLBACK === "true";

export function isLLMAvailable() { return SENSENOVA_KEYS.length > 0 || (ALLOW_PAID && !!process.env.DEEPSEEK_API_KEY); }
export function availableKeyCount() { return SENSENOVA_KEYS.length; }

let rr = 0;
function nextSensenovaIndex() { const i = rr % Math.max(1, SENSENOVA_KEYS.length); rr++; return i; }

async function callOne(ep, messages, { temperature = 0, maxTokens = 2048, timeoutMs = 45000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = { model: ep.model, messages, temperature, max_tokens: maxTokens };
    if (/sensenova/i.test(ep.url) || /sensenova/i.test(ep.model)) body.thinking = { type: "disabled" };
    const res = await fetch(ep.url, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${ep.key}` },
      body: JSON.stringify(body), signal: controller.signal,
    });
    if (!res.ok) {
      const err = await res.text().catch(() => "");
      const statusErr = new Error(`[${ep.name}] HTTP ${res.status}: ${err.slice(0, 200)}`);
      statusErr.httpStatus = res.status;
      if (res.status === 429) { const ra = res.headers.get("retry-after"); statusErr.retryAfter = ra ? parseInt(ra, 10) * 1000 : null; }
      throw statusErr;
    }
    const data = await res.json();
    const choice = data?.choices?.[0];
    const text = choice?.message?.content || "";
    if (!text) {
      const fr = choice?.finish_reason || "unknown";
      throw new Error(`[${ep.name}] 空响应（finish_reason=${fr}${fr === "length" ? "，疑 maxTokens 过小被思考耗尽" : ""}）`);
    }
    return text;
  } finally { clearTimeout(timer); }
}

const MAX_KEY_ATTEMPTS = 5;
const RETRY_BASE_MS = 1000;
const RETRY_CAP_MS = 15000;

export async function callLLM(messagesOrString, opts = {}) {
  const messages = typeof messagesOrString === "string" ? [{ role: "user", content: messagesOrString }] : messagesOrString;
  // 评测模式：优先走 JUDGE_MODEL 指定的模型（免费/付费均可，自动降级）
  if (opts.judgeModel) {
    const jeps = judgeEndpoints();
    if (jeps.length) {
      let lastErr;
      let backoff = 0;
      for (let i = 0; i < 5; i++) {  // 最多 5 次，含退避
        const ep = jeps[0];
        try { return await callOne(ep, messages, opts); }
        catch (e) {
          lastErr = e;
          if (e.httpStatus === 429) {
            const wait = Math.min(2000 * Math.pow(2, backoff) + Math.random() * 1000, 30000);
            backoff++;
            console.warn(`[llm-judge] ${JUDGE_MODEL} 429 退避 ${Math.round(wait)}ms (第${i+1}次)`);
            await new Promise((r) => setTimeout(r, wait));
            continue;
          }
          break;
        }
      }
      console.warn(`[llm-judge] ${JUDGE_MODEL} 不可用，退回 sensenova-6.7-flash-lite:`, lastErr?.message?.slice(0, 60));
    }
  }
  const sens = sensenovaEndpoints();
  let lastErr;
  if (sens.length) {
    const start = nextSensenovaIndex();
    const attempts = Math.min(MAX_KEY_ATTEMPTS, sens.length);
    let backoffAttempt = 0;
    for (let i = 0; i < attempts; i++) {
      const ep = sens[(start + i) % sens.length];
      try { return await callOne(ep, messages, opts); }
      catch (e) {
        lastErr = e;
        if (e.httpStatus === 429) {
          const wait = e.retryAfter || RETRY_BASE_MS * Math.pow(2, backoffAttempt);
          const jitter = Math.random() * (RETRY_BASE_MS / 2);
          backoffAttempt++;
          await new Promise((r) => setTimeout(r, Math.min(wait + jitter, RETRY_CAP_MS)));
          continue;
        }
      }
    }
  }
  const d = deepseekEndpoint();
  if (d && ALLOW_PAID) {
    try { return await callOne(d, messages, opts); } catch (e) { lastErr = e; }
  }
  throw new Error(ALLOW_PAID ? `所有 LLM 端点不可用：${lastErr?.message || ""}` : `免费 Key 不可用，付费未授权：${lastErr?.message || ""}`);
}

export async function runWithConcurrency(tasks, limit = SENSENOVA_CONCURRENCY) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() { while (idx < tasks.length) { const cur = idx++; results[cur] = await tasks[cur](); } }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, tasks.length)) }, worker));
  return results;
}

export async function checkKeyHealth() {
  const sens = sensenovaEndpoints();
  const tasks = sens.map((ep, i) => async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callOne(ep, [{ role: "user", content: "回复：ok" }], { temperature: 0, maxTokens: 1024, timeoutMs: 30000 });
        return { index: i + 1, ok: true, sample: text.slice(0, 24) };
      } catch (e) {
        const msg = String(e?.message || e);
        if (attempt === 0 && /abort|timeout/i.test(msg)) continue;
        return { index: i + 1, ok: false, error: msg.slice(0, 140) };
      }
    }
    return { index: i + 1, ok: false, error: "unknown" };
  });
  return runWithConcurrency(tasks, MAX_CONCURRENCY);
}
