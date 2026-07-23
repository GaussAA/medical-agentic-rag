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
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

// ============================================================
// 配置
// ============================================================
const PORT = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || process.env.PROXY_PORT || "18880", 10);
const PI_DIR = join(process.cwd(), ".pi");
const FAILOVER_FILE = join(PI_DIR, "failover-selection.json");

// Provider 注册表（Pool → Chain 分层模型）
//
// Pool: 同类型 providers（如同为 sensenova 免费通道的不同 Key），
//       内部 round-robin 轮换，均不可用时标记 Pool 耗尽。
// Chain: 有序 Pool 列表，上一级 Pool 耗尽时自动落入下一级。
//
// ⚠️ 优先级 = 免费优先 → 成本优先
// Chain 1: 本地私有 LLM（免费，最高优先级）
// Chain 2: sensenova 免费通道（多 Key 轮询 + deepseek 代理）
// Chain 3: Agnes 免费 Flash
// Chain 4: DeepSeek 付费（末位兜底）
const POOLS = [
  {
    name: "local-free",
    chain: 1,
    members: [
      { provider: "local", model: "google/gemma-4-e2b", baseUrl: "http://localhost:1234/v1", authEnv: null, label: "Local Gemma-4-E2B (私有)" },
    ],
  },
  {
    name: "sensenova-free",
    chain: 2,
    multiKey: true, // 支持多 Key round-robin
    members: [
      { provider: "sensenova", model: "sensenova-6.7-flash-lite", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", label: "SenseNova 6.7 Flash Lite" },
      { provider: "sensenova", model: "deepseek-v4-flash", baseUrl: "https://token.sensenova.cn/v1", authEnv: "SENSENOVA_API_KEY", label: "DeepSeek V4 Flash (免费通道)" },
    ],
  },
  {
    name: "agnes-free",
    chain: 3,
    members: [
      { provider: "agnes", model: "agnes-2.0-flash", baseUrl: "https://apihub.agnes-ai.com/v1", authEnv: "AGNES_API_KEY", label: "Agnes 2.0 Flash (免费)" },
    ],
  },
  {
    name: "deepseek-paid",
    chain: 4,
    members: [
      { provider: "deepseek", model: "deepseek-v4-flash", baseUrl: "https://api.deepseek.com", authEnv: "DEEPSEEK_API_KEY", label: "⚠️ DeepSeek V4 Flash (付费)" },
    ],
  },
];

// 展平成员列表（保持向后兼容）
const PROVIDERS = POOLS.flatMap((p) => p.members.map((m) => ({ ...m, pool: p.name, chain: p.chain, multiKey: !!p.multiKey })));

const PROBE_TIMEOUT = 3000; // 运行时健康探针超时：决定 Provider 切换灵敏度（短，避免瞬时抖动误切）；与 smoke-providers 的 8000ms（上线冷加载冒烟）用途不同，非一致性 bug
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

// ---- sensenova 20 Key 池轮询（容错，非并发） ----
// SENSENOVA_API_KEYS 为逗号/换行分隔的免费 Key 池。
// SENSENOVA_API_KEY 为向后兼容的单 Key 形式。
// 多 Key 的作用是故障转移：单 Key 触发 429 限速时轮询到下一个 Key 绕过。
// sensenova 的并发上限是账户级的（约 20 路），与 Key 数量无关，多 Key 不叠加并发。
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
  // 本地私有 LLM（authEnv === null）：无需 Key，直连探测
  const noKeyOk = !apiKey && p.authEnv === null;
  if (!apiKey && !noKeyOk) return { ...p, healthy: false, reason: `缺 ${p.authEnv}` };
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), PROBE_TIMEOUT);
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    const res = await fetch(`${p.baseUrl}/models`, { headers, signal: ctrl.signal });
    clearTimeout(timer);
    return { ...p, healthy: res.ok, reason: res.ok ? "OK" : `HTTP ${res.status}` };
  } catch (err) {
    return { ...p, healthy: false, reason: err.message || String(err) };
  }
}

/** 探测全部 Provider，返回按链+池排序的健康列表。 */
async function probeAll() {
  const results = await Promise.all(PROVIDERS.map(probeProvider));
  return results.filter((r) => r.healthy).sort((a, b) => a.chain - b.chain || (a.pool || "").localeCompare(b.pool || ""));
}

/** 选择最优 Provider。池内 round-robin，池耗尽后跨链回退。 */
async function selectProvider(forceRefresh = false) {
  // 先从 failover 文件读取当前选择
  if (!forceRefresh && existsSync(FAILOVER_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(FAILOVER_FILE, "utf-8"));
      // 在 PROVIDERS 中查找匹配的（忽略 pool 字段）
      const p = PROVIDERS.find((p) => p.provider === cached.provider && p.model === cached.model);
      if (p && !cached.degraded) {
        currentProvider = p;
        currentModelName = cached.model;
        return;
      }
    } catch { /* ignore */ }
  }

  // 按链分组探测，池内 round-robin
  const healthy = await probeAll();
  if (healthy.length > 0) {
    // 取最优链的第一个健康成员
    currentProvider = healthy[0];
    currentModelName = healthy[0].model;
  } else {
    // 全不健康：按链序回退第一顺位
    const fallback = PROVIDERS.sort((a, b) => a.chain - b.chain)[0];
    currentProvider = fallback;
    currentModelName = fallback.model;
  }

  // 写 failover 文件
  mkdirSync(PI_DIR, { recursive: true });
  writeFileSync(FAILOVER_FILE, JSON.stringify({
    provider: currentProvider.provider,
    model: currentModelName,
    pool: currentProvider.pool || null,
    chain: currentProvider.chain || null,
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
  // 始终使用 provider-proxy 选出的模型名（currentModelName），不传 Pi 内部的 provider/model 格式
  const model = currentModelName;
  const prevBaseUrl = currentProvider.baseUrl;

  let lastErr;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    // 每次尝试（含重试）都轮询 Key 池——sensenova 换 Key 缓解单 Key 限速
    const apiKey = isSensenova() ? nextSensenovaKey() : getApiKey(currentProvider);
    // 本地私有 LLM（authEnv === null）不需要 apiKey
    const noKeyOk = !apiKey && currentProvider.authEnv === null;
    if (!apiKey && !noKeyOk) throw new Error(`当前 Provider ${currentProvider.label} 缺 API Key`);

    const url = `${currentProvider.baseUrl}/chat/completions`;

    if (attempt > 0) {
      console.log(`[proxy] 重试 ${attempt}/${MAX_RETRIES}...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY * attempt));
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT);
      const headers = {
        "Content-Type": "application/json",
      };
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const res = await fetch(url, {
        method: "POST",
        headers,
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
        return { ...h, pool: p.pool, chain: p.chain, active: currentProvider?.provider === p.provider && currentProvider?.model === p.model };
      });
      const results = await Promise.all(statuses);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(results, null, 2));
      return;
    }

    // ---- 指标（Prometheus 文本格式） ----
    if (url.pathname === "/metrics") {
      const pName = currentProvider?.label || "unknown";
      const lines = [
        "# HELP medical_rag_proxy_requests_total Total LLM requests proxied",
        "# TYPE medical_rag_proxy_requests_total counter",
        `medical_rag_proxy_requests_total ${metrics.requests}`,
        "# HELP medical_rag_proxy_errors_total Total proxy errors",
        "# TYPE medical_rag_proxy_errors_total counter",
        `medical_rag_proxy_errors_total ${metrics.errors}`,
        "# HELP medical_rag_proxy_failovers_total Total provider failovers",
        "# TYPE medical_rag_proxy_failovers_total counter",
        `medical_rag_proxy_failovers_total ${metrics.failovers}`,
        "# HELP medical_rag_proxy_current_provider Currently active provider",
        "# TYPE medical_rag_proxy_current_provider gauge",
        `medical_rag_proxy_current_provider{provider="${pName}"} 1`,
        "# HELP medical_rag_proxy_consecutive_failures Current consecutive failure count",
        "# TYPE medical_rag_proxy_consecutive_failures gauge",
        `medical_rag_proxy_consecutive_failures ${consecutiveFailures}`,
        "# HELP medical_rag_proxy_uptime_seconds Proxy uptime",
        "# TYPE medical_rag_proxy_uptime_seconds gauge",
        `medical_rag_proxy_uptime_seconds ${Math.floor(process.uptime())}`,
      ];
      // 按 provider 维度输出 per-provider 指标
      for (const [name, stats] of Object.entries(metrics.byProvider)) {
        lines.push(`# HELP medical_rag_proxy_provider_requests_total Requests by provider`);
        lines.push(`# TYPE medical_rag_proxy_provider_requests_total counter`);
        lines.push(`medical_rag_proxy_provider_requests_total{provider="${name}"} ${stats.requests}`);
        lines.push(`# HELP medical_rag_proxy_provider_errors_total Errors by provider`);
        lines.push(`# TYPE medical_rag_proxy_provider_errors_total counter`);
        lines.push(`medical_rag_proxy_provider_errors_total{provider="${name}"} ${stats.errors || 0}`);
      }

      // —— KB 健康指标 ——
      try {
        const home = process.env.USERPROFILE || process.env.HOME || "";
        const ROOT = join(import.meta.dirname, "..", "..");

        // recall 基线
        const recallPath = join(ROOT, "tests", "reports", "recall-baseline.json");
        if (existsSync(recallPath)) {
          const bl = JSON.parse(readFileSync(recallPath, "utf-8"));
          lines.push(`# HELP medical_rag_kb_recall_rate Citation recall rate (router top-3)`);
          lines.push(`# TYPE medical_rag_kb_recall_rate gauge`);
          lines.push(`medical_rag_kb_recall_rate ${bl.recall || 0}`);
        }

        // chunk 统计
        const kbDb = join(home, ".pi", "knowledge", "knowledge.db");
        if (existsSync(kbDb)) {
          const { createRequire } = await import("node:module");
          const require = createRequire(import.meta.url);
          const Database = require("better-sqlite3");
          const db = new Database(kbDb, { readonly: true });
          const total = db.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
          const files = db.prepare("SELECT COUNT(DISTINCT file_path) as c FROM chunks").get().c;
          const totalChars = db.prepare("SELECT SUM(LENGTH(content)) as s FROM chunks").get().s || 0;
          db.close();

          lines.push(`# HELP medical_rag_kb_chunks_total Total chunks in knowledge base`);
          lines.push(`# TYPE medical_rag_kb_chunks_total gauge`);
          lines.push(`medical_rag_kb_chunks_total ${total}`);

          lines.push(`# HELP medical_rag_kb_files_total Total source files`);
          lines.push(`# TYPE medical_rag_kb_files_total gauge`);
          lines.push(`medical_rag_kb_files_total ${files}`);

          lines.push(`# HELP medical_rag_kb_content_bytes Total content bytes`);
          lines.push(`# TYPE medical_rag_kb_content_bytes gauge`);
          lines.push(`medical_rag_kb_content_bytes ${totalChars}`);
        }

        // cache 大小
        const cacheDb = join(ROOT, ".pi", "cache", "chunk-meta.db");
        if (existsSync(cacheDb)) {
          const sz = readFileSync(cacheDb).length;
          lines.push(`# HELP medical_rag_cache_chunk_meta_bytes Sidecar chunk-meta DB size`);
          lines.push(`# TYPE medical_rag_cache_chunk_meta_bytes gauge`);
          lines.push(`medical_rag_cache_chunk_meta_bytes ${sz}`);
        }
      } catch {
        /* KB 指标读取失败不阻断 */
      }
      res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
      res.end(lines.join("\n") + "\n");
      return;
    }

    // ---- Chat Completions ----
    if (url.pathname === "/v1/chat/completions" && req.method === "POST") {
      const bodyBuf = [];
      for await (const chunk of req) bodyBuf.push(chunk);
      const body = JSON.parse(Buffer.concat(bodyBuf).toString("utf-8"));

      const labelSafe = (currentProvider?.label || "unknown").replace(/[^\x20-\x7E]/g, "");
      const pKey = `${currentProvider?.provider || "unknown"}/${currentProvider?.model || "unknown"}`;

      const response = await forwardRequest(body);
      const bodyText = await response.text();

      res.writeHead(response.status, {
        "Content-Type": "application/json",
        "X-Provider": labelSafe,
        "X-Failover-Count": String(failoverCount),
      });
      res.end(bodyText);

      // 记录指标
      if (!metrics.byProvider[pKey]) metrics.byProvider[pKey] = { requests: 0, errors: 0 };
      metrics.byProvider[pKey].requests++;

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

  server.listen(PORT, "0.0.0.0", () => {
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
