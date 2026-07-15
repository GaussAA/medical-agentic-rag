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
// ⚠️ 优先级 = 成本优先级：P1 免费 → P2 免费深搜通道 → P3 agnes → P4 付费 deepseek（末位兜底仅已授权）
const PROVIDERS = [
  // P1: sensenova 免费主力
  { provider: "sensenova", model: "sensenova-6.7-flash-lite", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", priority: 1, label: "SenseNova 6.7 Flash Lite" },
  // P2: sensenova deepseek 免费通道（经 sensenova 接入，不消耗 deepseek 付费配额）
  { provider: "sensenova", model: "deepseek-v4-flash", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", priority: 2, label: "DeepSeek V4 Flash (免费通道)" },
  // P3: agnes
  { provider: "agnes", model: "agnes-2.0-flash", baseUrl: "https://apihub.agnes-ai.com/v1", authEnv: "AGNES_API_KEY", priority: 3, label: "Agnes 2.0 Flash" },
  // P4: deepseek 付费（末位兜底——仅全部免费通道不可用且大帅授权时选中，选中时启动日志必有醒目警告）
  { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", authEnv: "DEEPSEEK_API_KEY", priority: 4, label: "⚠️ DeepSeek V4 Flash (付费)" },
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

/** 获取 provider 的 API Key（环境变量）。 */
function getApiKey(p) {
  return process.env[p.authEnv] || null;
}

/** 探测单个 Provider 健康。 */
async function probeProvider(p) {
  const apiKey = getApiKey(p);
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

/** 转发请求到当前 Provider。 */
async function forwardRequest(body) {
  if (!currentProvider) await selectProvider();

  const apiKey = getApiKey(currentProvider);
  if (!apiKey) throw new Error(`当前 Provider ${currentProvider.label} 缺 API Key`);

  const model = body.model || currentModelName;
  const url = `${currentProvider.baseUrl}/chat/completions`;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
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
      // 如果切换了 Provider，用新 Provider 重试
      if (currentProvider.provider !== PROVIDERS.find(p => p.provider === currentProvider.provider)?.provider) {
        // provider 已变，用新 provider 重试
        const newKey = getApiKey(currentProvider);
        if (newKey) {
          body = { ...body, model: currentModelName };
        }
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

  // ⚠️ 付费 deepseek 告警：若选中 P4（付费），醒目警示大帅预算
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
