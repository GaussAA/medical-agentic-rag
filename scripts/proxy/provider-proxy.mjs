// scripts/proxy/provider-proxy.mjs
// LLM Provider 本地代理网关 —— 零宕机热切换核心层。
//
// 功能：
//   1. OpenAI 兼容 `/v1/chat/completions` 端点
//   2. 断路器 + 自动重试 + Provider 热切换
//   3. 健康探测端点 `/health` `/providers` `/metrics`
//   4. 共享 failover 状态（.pi/failover-selection.json）
//
// 架构：
//   Pi Agent → http://localhost:18880/v1/chat/completions
//            → provider-proxy → (deepseek | agnes | sensenova)
//
// 用法：
//   node scripts/proxy/provider-proxy.mjs [--port 18880]
//
// 纯 node 运行，零外部依赖。

import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// 配置
// ============================================================
const PORT = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || process.env.PROXY_PORT || "18880", 10);
const PI_DIR = join(process.cwd(), ".pi");
const FAILOVER_FILE = join(PI_DIR, "failover-selection.json");

// Provider 注册表（复用 provider-health.mjs 定义，独立副本防循环依赖）
// ⚠️ 优先级 = 成本优先级：P1 免费 → P2 免费深搜 → P3 Agnes2.5(新) → P4 Agnes2.0 → P5 付费 deepseek（末位兜底）
const PROVIDERS = [
  // P1: sensenova 免费主力
  { provider: "sensenova", model: "sensenova-6.7-flash-lite", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", priority: 1, label: "SenseNova 6.7 Flash Lite" },
  // P2: sensenova deepseek 免费通道（经 sensenova 接入，不消耗 deepseek 付费配额）
  { provider: "sensenova", model: "deepseek-v4-flash", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", priority: 2, label: "DeepSeek V4 Flash (免费通道)" },
  // P3: Agnes 2.5 Flash（2026-07-13 发布，免费，更强）
  { provider: "agnes", model: "agnes-2.5-flash", baseUrl: "https://apihub.agnes-ai.com/v1", authEnv: "AGNES_API_KEY", priority: 3, label: "Agnes 2.5 Flash (免费·新)" },
  // P4: Agnes 2.0 Flash（免费，1M 上下文）
  { provider: "agnes", model: "agnes-2.0-flash", baseUrl: "https://apihub.agnes-ai.com/v1", authEnv: "AGNES_API_KEY", priority: 4, label: "Agnes 2.0 Flash (免费)" },
  // P5: deepseek 付费（末位兜底——仅全部免费通道不可用且大帅授权时选中，选中时启动日志必有醒目警告）
  { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", authEnv: "DEEPSEEK_API_KEY", priority: 5, label: "⚠️ DeepSeek V4 Flash (付费)" },
];

const PROBE_TIMEOUT = 3000;
const REQUEST_TIMEOUT = 60000;
const RETRY_DELAY = 1000;
const MAX_RETRIES = 2;
const CIRCUIT_BREAKER_THRESHOLD = 3; // 连续失败 N 次后切换
const DEBOUNCE_MS = 5000; // 切换后冷却期，不重复切换

// ============================================================
// 状态
// ============================================================
let currentProvider = null;  // 当前活跃 provider
let currentModelName = null; // 实际请求时用的 model 名
let consecutiveFailures = 0;
let lastSwitch = 0;
let requestCount = 0;
let failoverCount = 0;
let metrics = { requests: 0, errors: 0, failovers: 0, byProvider: {} };

// ============================================================
// 核心逻辑
// ============================================================

/** 获取 provider 的 API Key（环境变量）。单 Key 模式（非 sensenova）。 */
function getApiKey(p) {
  return process.env[p.authEnv] || null;
}

// ---- sensenova 20 Key 池并发轮询 ----
// SENSENOVA_API_KEYS 为逗号/换行分隔的免费 Key 池（最多 20 并发）；
// SENSENOVA_API_KEY 为向后兼容的单 Key 形式。合并为一池，按轮询分发，
// 使所有经 proxy 路由至 sensenova 的请求（P1 免费 / P2 免费深搜）都能利用并发额度。
function parseKeys(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
const SENSENOVA_KEY_POOL = (() => {
  const keys = parseKeys(process.env.SENSENOVA_API_KEYS || process.env.SENSENOVA_API_KEY || "");
  if (process.env.SENSENOVA_API_KEY && !keys.includes(process.env.SENSENOVA_API_KEY)) {
    keys.push(process.env.SENSENOVA_API_KEY);
  }
  return keys;
})();
let rrKeyIdx = 0;
/** 轮询取下一个 sensenova Key。 */
function nextSensenovaKey() {
  if (!SENSENOVA_KEY_POOL.length) return null;
  const key = SENSENOVA_KEY_POOL[rrKeyIdx % SENSENOVA_KEY_POOL.length];
  rrKeyIdx = (rrKeyIdx + 1) % SENSENOVA_KEY_POOL.length;
  return key;
}

/** 探测单个 Provider 健康。sensenova 类回退到 Key 池取首个 Key。 */
async function probeProvider(p) {
  // sensenova 类：先试单 Key，若无则从 Key 池取首个
  let apiKey = getApiKey(p);
  if (!apiKey && p.authEnv === "SENSENOVA_API_KEY" && SENSENOVA_KEY_POOL.length) {
    apiKey = SENSENOVA_KEY_POOL[0];
  }
  if (!apiKey) return { ...p, healthy: false, reason: `缺 ${p.authEnv}` };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    const res = await fetch(`${p.baseUrl}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctrl.signal,
    });
    clearTimeout(timer);
    return { ...p, healthy: res.ok, reason: res.ok ? "OK" : `HTTP ${res.status}` };
  } catch (err) {
    return { ...p, healthy: false, reason: err.message || String(err) };
  }
}

/** 探测全部 Provider，返回按优先级排序的健康列表。 */
async function probeAll() {
  const results = await Promise.all(PROVIDERS.map(probeProvider));
  return results.filter((r) => r.healthy).sort((a, b) => a.priority - b.priority);
}

/** 选择最优 Provider。优先使用当前（未降级），否则选第一个健康的。 */
async function selectProvider(forceRefresh = false) {
  // 先从 failover 文件读取当前选择
  if (!forceRefresh && existsSync(FAILOVER_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(FAILOVER_FILE, "utf-8"));
      const p = PROVIDERS.find((p) => p.provider === cached.provider && p.model === cached.model);
      if (p && !cached.degraded) {
        currentProvider = p;
        currentModelName = cached.model;
        return;
      }
    } catch { /* ignore */ }
  }

  const healthy = await probeAll();
  if (healthy.length > 0) {
    currentProvider = healthy[0];
    currentModelName = healthy[0].model;
  } else {
    // 全不健康：回退 priority 最小者（降级）
    const fallback = [...PROVIDERS].sort((a, b) => a.priority - b.priority)[0];
    currentProvider = fallback;
    currentModelName = fallback.model;
  }

  // 写 failover 文件
  mkdirSync(PI_DIR, { recursive: true });
  writeFileSync(FAILOVER_FILE, JSON.stringify({
    provider: currentProvider.provider,
    model: currentModelName,
    degraded: !healthy.length,
    label: currentProvider.label,
    ts: new Date().toISOString(),
  }, null, 2));
}

/** 断路器：连续失败达阈值则切换。 */
async function onError(err) {
  consecutiveFailures++;
  metrics.errors++;
  const now = Date.now();
  if (consecutiveFailures >= CIRCUIT_BREAKER_THRESHOLD && now - lastSwitch > DEBOUNCE_MS) {
    console.error(`[proxy] ⚠ 连续 ${consecutiveFailures} 次失败，触发断路器，尝试切换 Provider...`);
    await selectProvider(true);
    consecutiveFailures = 0;
    lastSwitch = now;
    failoverCount++;
    metrics.failovers++;
    console.error(`[proxy] ✓ 已切换至 ${currentProvider.label}`);
  }
}

/** 成功时重置失败计数。 */
function onSuccess() {
  consecutiveFailures = 0;
}

/** 转发请求到当前 Provider，sensenova 路由走 Key 池轮询助力并发。 */
async function forwardRequest(body) {
  if (!currentProvider) await selectProvider();

  const isSensenova = () => currentProvider.baseUrl.includes("token.sensenova.cn");
  const model = body.model || currentModelName;
  const prevBaseUrl = currentProvider.baseUrl;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 每次尝试（含重试）都轮询 Key 池——sensenova 换 Key 缓解单 Key 限速
    const apiKey = isSensenova() ? nextSensenovaKey() : getApiKey(currentProvider);
    if (!apiKey) throw new Error(`当前 Provider ${currentProvider.label} 缺 API Key`);

    const url = `${currentProvider.baseUrl}/chat/completions`;

    if (attempt > 0) {
      console.log(`[proxy] 重试 ${attempt}/${MAX_RETRIES}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY * attempt));
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({ ...body, model }),
        signal: ctrl.signal,
      });
      clearTimeout(timer);

      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
      }

      onSuccess();
      return res;
    } catch (err) {
      lastErr = err;
      await onError(err);
      // 断路器切换 Provider 后，baseUrl 已变，重试用新 endpoint
      if (currentProvider.baseUrl !== prevBaseUrl) {
        // 新 Provider 无需保留旧 body 中的 model 名
        body = { ...body, model: currentModelName };
      }
    }
  }
  throw lastErr || new Error("所有重试均失败");
}

// ============================================================
// HTTP 服务器
// ============================================================

const server = createServer(async (req, res) => {
  const start = Date.now();
  metrics.requests++;
  requestCount++;

  // CORS
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    const url = new URL(req.url, `http://localhost:${PORT}`);

    // ---- 健康端点 ----
    if (url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        status: "ok",
        provider: currentProvider?.label || "未选择",
        uptime: process.uptime(),
        requests: metrics.requests,
        errors: metrics.errors,
        failovers: metrics.failovers,
      }));
      return;
    }

    // ---- Provider 状态 ----
    if (url.pathname === "/providers") {
      const probes = await probeAll();
      const all = PROVIDERS.map((p) => {
        const healthy = probes.find((r) => r.provider === p.provider && r.model === p.model);
        return {
          provider: p.provider,
          model: p.model,
          label: p.label,
          healthy: healthy ? true : false,
          active: currentProvider?.provider === p.provider && currentProvider?.model === p.model,
        };
      });
      const statuses = PROVIDERS.map(async (p) => {
        const h = await probeProvider(p);
        return { ...h, active: currentProvider?.provider === p.provider && currentProvider?.model === p.model };
      });
      const results = await Promise.all(statuses);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
      return;
    }

    // ---- 指标 ----
    if (url.pathname === "/metrics") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ...metrics,
        currentProvider: currentProvider?.label,
        consecutiveFailures,
        uptime: process.uptime(),
      }, null, 2));
      return;
    }

    // ---- Chat Completions ----
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const bodyBuf = [];
      for await (const chunk of req) bodyBuf.push(chunk);
      const body = JSON.parse(Buffer.concat(bodyBuf).toString("utf-8"));

      const response = await forwardRequest(body);
      const bodyText = await response.text();

      res.writeHead(response.status, {
        "Content-Type": "application/json",
        "X-Provider": currentProvider?.label || "unknown",
        "X-Failover-Count": String(failoverCount),
      });
      res.end(bodyText);

      // 记录指标
      const pName = currentProvider?.label || "unknown";
      if (!metrics.byProvider[pName]) metrics.byProvider[pName] = { requests: 0, errors: 0 };
      metrics.byProvider[pName].requests++;

      const elapsed = Date.now() - start;
      console.log(`[proxy] ${elapsed}ms ${response.status} ${currentProvider?.label} (failovers=${failoverCount})`);
      return;
    }

    // ---- 404 ----
    res.writeHead(404);
    res.end("Not found");
  } catch (err) {
    console.error("[proxy] 请求处理失败:", err.message);
    res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: err.message }));
  }
});

// ============================================================
// 启动
// ============================================================

async function start() {
  // 启动时先选 Provider
  await selectProvider();
  console.log(`[proxy] Provider 初始选择: ${currentProvider?.label} (${currentProvider?.provider}/${currentModelName})`);

  // ⚠️ 付费 deepseek 告警：若选中付费 deepseek（provider=deepseek），醒目警示大帅预算
  if (currentProvider?.provider === "deepseek" && currentModelName === "deepseek-v4-flash") {
    console.warn("=".repeat(70));
    console.warn("⚠  ⚠  ⚠  ⚠  注  意  ⚠  ⚠  ⚠  ⚠");
    console.warn("当前选中了  DeepSeek V4 Flash（付费模型）！");
    console.warn("所有免费通道（sensenova-6.7-flash-lite / sensenova 深搜免费通道 / agnes）均不可用。");
    console.warn("每次请求将消耗 DEEPSEEK_API_KEY 的付费配额。");
    console.warn("如需关闭付费，请停止服务、检查免费通道可用性，或设置 ALLOW_PAID_FALLBACK=false。");
    console.warn("=".repeat(70));
  }

  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[proxy] LLM Provider 代理网关运行于 http://127.0.0.1:${PORT}`);
    console.log(`[proxy] 端点:`);
    console.log(`  POST /v1/chat/completions  ← Pi Agent 请求入口`);
    console.log(`  GET  /health               健康检查`);
    console.log(`  GET  /providers             Provider 状态`);
    console.log(`  GET  /metrics               指标`);
    console.log(`[proxy] 断路器阈值: ${CIRCUIT_BREAKER_THRESHOLD} 次连续失败后自动切换`);
  });
}

start().catch((err) => {
  console.error("[proxy] 启动失败:", err);
  process.exit(1);
});
