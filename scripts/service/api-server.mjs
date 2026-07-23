// scripts/service/api-server.mjs
// 医疗 Agentic RAG —— Agent 服务化 HTTP API（T8）
//
// 暴露干净的「提交问题 → 拿结构化回答」接口，把 Pi RPC 会话包成可调用服务：
//   POST /api/v1/ask      {question, sessionId?, patientProfile?, timeoutMs?}
//   POST /api/v1/model    零重启热切换模型 {provider, model}
//   GET  /api/v1/models   可用模型列表
//   POST /api/v1/feedback {query, rating, comment?}  用户反馈
//   GET  /healthz         存活探针
//   GET  /metrics         Prometheus 指标（复用 metrics-format）
//
// 特性：Bearer 鉴权、每会话熔断+重试、provider-proxy 自举、优雅关停。
//
// 测试友好：导出 createApiHandler({pool,...})，单测注入 mock pool；
//   NODE_ENV=test 时不自动启动主流程。

import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { maskPII } from "../../.pi/extensions/lib/phi-crypto.mjs";
import { PiWorker } from "./pi-bridge.mjs";
import { SessionPool, PoolFullError } from "./session-pool.mjs";
import { CircuitBreaker, CircuitOpenError, retry } from "./circuit-breaker.mjs";
import { renderMedicalRagMetrics } from "../ci/metrics/metrics-format.mjs";
import { resolveNodeBin, toNativePath } from "./node-bin.mjs";

function readFailover() {
  try {
    const p = join(process.cwd(), ".pi", "failover-selection.json");
    if (existsSync(p)) {
      const j = JSON.parse(readFileSync(p, "utf8"));
      if (j.provider && j.model) return `${j.provider}/${j.model}`;
    }
  } catch {
    /* noop */
  }
  return null;
}

export function makeConfig(overrides = {}) {
  const cwd = process.cwd();
  const ff = readFailover();
  // Pi Agent 的 --model 须用 Pi 内置认识的模型（仅 deepseek 系列被注册）；
  // 实际 LLM 调用由 preload-fetch-proxy 劫持至本地 provider-proxy(18880)，
  // 由 proxy 按健康探测路由到免费通道（sensenova 的 deepseek-v4-flash 免费通道 P4）。
  // 注意：failover-selection.json 选出的 sensenova 系 proxy/llm-judge 层策略，
  // 不可直接作为 Pi 的 --model（Pi 不识别 sensenova 模型名，否则启动即 exit 1）。
  const model =
    overrides.model ||
    (process.env.LLM_PROVIDER && process.env.LLM_MODEL
      ? `${process.env.LLM_PROVIDER}/${process.env.LLM_MODEL}`
      : null) ||
    "deepseek/deepseek-v4-flash";
  return {
    port: Number(process.env.API_PORT || 8080),
    host: process.env.API_HOST || "127.0.0.1",
    apiToken: process.env.API_TOKEN || "", // 空=仅本机回环开放（非本机暴露须设 API_TOKEN，否则 fail-closed 拒 401）
    proxyPort: Number(process.env.PROXY_PORT || 18880),
    nodeBin: resolveNodeBin(),
    model,
    systemPrompt: join(cwd, ".pi", "prompts", "medical-agent.md"),
    sessionDir: join(cwd, ".pi", "sessions"),
    auditLogDir: join(cwd, ".pi", "logs"),
    maxSessions: Number(process.env.API_MAX_SESSIONS || 8),
    idleTtlMs: Number(process.env.API_IDLE_TTL_MS || 10 * 60 * 1000),
    askTimeoutMs: Number(process.env.API_ASK_TIMEOUT_MS || 120000),
    ...overrides,
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function readBody(req, limit = 1_048_576) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// 服务启动时间戳（供 /healthz、/metrics 计算 uptime）
export const SERVER_STARTED_AT = Date.now();

// 判断服务是否仅绑定本机回环（用于安全告警与开放策略）。
// 模块级定义：createApiHandler 内与顶层 server.listen 回调均需访问。
function isLocalHost(host) {
  return (
    host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "::"
  );
}

export function createApiHandler({
  pool,
  config,
  breakers = new Map(),
  log = () => {},
}) {
  function authenticate(req) {
    // 显式开发绕过（默认关闭）：仅本地联调使用，生产须删除
    if (process.env.API_AUTH_DISABLED === "1") return true;
    if (config.apiToken) {
      const h = req.headers["authorization"] || "";
      const m = /^Bearer\s+(.+)$/i.exec(h);
      return !!m && m[1] === config.apiToken;
    }
    // 无 token：仅当服务绑定本机回环才允许开放（fail-closed——
    // 非本机暴露必须设 API_TOKEN，否则一律 401，杜绝生产裸奔）
    return isLocalHost(config.host);
  }

  function getBreaker(key) {
    let b = breakers.get(key);
    if (!b) {
      b = new CircuitBreaker({
        failureThreshold: Number(process.env.API_CB_FAILURES || 5),
        cooldownMs: Number(process.env.API_CB_COOLDOWN_MS || 30000),
        timeoutMs: config.askTimeoutMs,
        ignoreErrors: [PoolFullError], // 池满背压不计入下游故障，否则洪峰会误打 open 熔断
      });
      breakers.set(key, b);
    }
    return b;
  }

  return async function handler(req, res) {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname;

    try {
      // ---- 存活探针（liveness：宽松，仅探进程）----
      if (req.method === "GET" && path === "/healthz") {
        const info = pool.listSessions();
        return sendJson(res, 200, {
          status: info.defaultAlive ? "ok" : "degraded",
          pi: info.defaultAlive ? "up" : "down",
          uptimeMs: Date.now() - SERVER_STARTED_AT,
          activeSessions: info.sessions.length,
        });
      }

      // ---- 就绪探针（readiness：要求 Pi 真正可服务，供 K8s readinessProbe）----
      if (req.method === "GET" && path === "/readyz") {
        const info = pool.listSessions();
        if (info.defaultAlive) {
          return sendJson(res, 200, {
            status: "ready",
            pi: "up",
            uptimeMs: Date.now() - SERVER_STARTED_AT,
          });
        }
        return sendJson(res, 503, { status: "not ready", pi: "down" });
      }

      // ---- Prometheus 指标 ----
      if (req.method === "GET" && path === "/metrics") {
        res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
        return res.end(
          renderMedicalRagMetrics(config.auditLogDir, SERVER_STARTED_AT),
        );
      }

      // ---- 路由保护（需鉴权）----
      if (!authenticate(req)) {
        return sendJson(res, 401, {
          ok: false,
          error: "unauthorized",
          hint: "Authorization: Bearer <API_TOKEN>",
        });
      }

      // ---- 提问 ----
      if (req.method === "POST" && path === "/api/v1/ask") {
        const body = await readBody(req);
        const question =
          typeof body.question === "string" ? body.question.trim() : "";
        if (!question)
          return sendJson(res, 400, { ok: false, error: "question 不能为空" });
        const sessionId =
          typeof body.sessionId === "string" && body.sessionId
            ? body.sessionId
            : undefined;
        const timeoutMs =
          Number(body.timeoutMs) > 0
            ? Number(body.timeoutMs)
            : config.askTimeoutMs;
        const traceId = randomUUID();

        const prompt = body.patientProfile
          ? `${question}\n\n[患者资料（PHI，已按策略脱敏后注入）]\n${maskPII(String(body.patientProfile))}`
          : question;

        const breaker = getBreaker(sessionId || "__default__");
        let result;
        try {
          // 背压：池满立即 429——不经熔断/重试，避免误伤熔断阈值与无谓退避
          if (pool.isFull()) {
            throw new PoolFullError(
              `会话池已满（在途 ${pool.inflight}/${pool.maxSessions}），请稍后重试或横向扩容 Pod`,
            );
          }
          result = await retry(
            () =>
              breaker.exec(() =>
                pool.ask(sessionId, prompt, { timeoutMs, traceId }),
              ),
            {
              retries: 1,
              backoffMs: 300,
              shouldRetry: (err) =>
                !(err instanceof CircuitOpenError || err instanceof PoolFullError),
            },
          );
        } catch (err) {
          if (err instanceof CircuitOpenError || err instanceof PoolFullError) {
            return sendJson(res, 429, {
              ok: false,
              error: "service_unavailable",
              reason: err.message,
              traceId,
            });
          }
          return sendJson(res, err.message?.includes("Timeout") ? 504 : 500, {
            ok: false,
            error: "agent_error",
            reason: err.message,
            traceId,
          });
        }
        return sendJson(res, 200, { ...result, traceId });
      }

      // ---- 模型热切换（零重启）----
      if (req.method === "POST" && path === "/api/v1/model") {
        const body = await readBody(req);
        if (!body.provider || !body.model) {
          return sendJson(res, 400, {
            ok: false,
            error: "provider 与 model 必填",
          });
        }
        const sessionId =
          typeof body.sessionId === "string" && body.sessionId
            ? body.sessionId
            : undefined;
        const model = await pool.setModel(body.provider, body.model, sessionId);
        return sendJson(res, 200, { ok: true, model });
      }

      // ---- 可用模型 ----
      if (req.method === "GET" && path === "/api/v1/models") {
        const models = await pool.getAvailableModels().catch(() => []);
        return sendJson(res, 200, { ok: true, models });
      }

      // ---- 会话列表 ----
      if (req.method === "GET" && path === "/api/v1/sessions") {
        return sendJson(res, 200, { ok: true, ...pool.listSessions() });
      }

      // ---- 用户反馈 ----
      if (req.method === "POST" && path === "/api/v1/feedback") {
        if (!authenticate(req)) return sendJson(res, 401, { ok: false, error: "unauthorized" });
        const body = typeof req.body === "object" ? req.body : {};
        if (!body.query || body.rating === undefined) {
          return sendJson(res, 400, { ok: false, error: "query and rating required" });
        }
        const entry = {
          t: new Date().toISOString(),
          query: (body.query || "").slice(0, 500),
          response: (body.response || "").slice(0, 500),
          rating: Number(body.rating),
          comment: (body.comment || "").slice(0, 500),
          sessionId: body.sessionId || "",
          source: "api",
        };
        // 写入反馈日志
        const { mkdirSync, appendFileSync } = await import("node:fs");
        const { join } = await import("node:path");
        const { dirname } = await import("node:path");
        const { fileURLToPath } = await import("node:url");
        const serverRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
        const logDir = join(serverRoot, ".pi", "logs");
        mkdirSync(logDir, { recursive: true });
        const date = new Date().toISOString().slice(0, 10);
        appendFileSync(join(logDir, `feedback-${date}.ndjson`), JSON.stringify(entry) + "\n", "utf-8");
        return sendJson(res, 201, { ok: true, id: entry.t });
      }

      return sendJson(res, 404, { ok: false, error: "not found", path });
    } catch (err) {
      if (
        err.message === "payload too large" ||
        err.message === "invalid JSON body"
      ) {
        return sendJson(res, 400, { ok: false, error: err.message });
      }
      log(`[api] 未处理异常: ${err.stack || err.message}`);
      return sendJson(res, 500, {
        ok: false,
        error: "internal_error",
        reason: err.message,
      });
    }
  };
}

// ---- provider-proxy 自举 ----
// 兜底监督：provider-proxy 若意外退出，3s 后自举重试（对齐「无静默失败」）。
// 正常关停（code=0 且无 signal）不自举；期间 Pi 直连 Provider，不拖垮 API 服务。
let proxyRespawnGuard = false;
async function ensureProxy(config, log) {
  const url = `http://127.0.0.1:${config.proxyPort}/health`;
  try {
    const r = await fetch(url);
    if (r.ok) {
      log("[api] provider-proxy 已在运行");
      return null;
    }
  } catch {
    /* 未运行，下方拉起 */
  }
  log(`[api] 启动 provider-proxy (:${config.proxyPort})`);
  const nodeBin = toNativePath(config.nodeBin);
  const child = spawn(
    nodeBin,
    [
      join(process.cwd(), "scripts", "proxy", "provider-proxy.mjs"),
      `--port=${config.proxyPort}`,
    ],
    { cwd: process.cwd(), stdio: ["ignore", "pipe", "pipe"], env: process.env },
  );
  child.on("error", (e) => {
    // proxy 启动失败不应拖垮 API 服务：Pi 可直连 Provider（走 .env Key）
    log(
      `[api][告警] provider-proxy 启动失败，Pi 将直连 Provider：${e.message}`,
    );
    return null;
  });
  child.stderr?.on("data", (d) => log(`[proxy:stderr] ${d.toString().trim()}`));
  child.on("exit", (code, signal) => {
    if (code === 0 && !signal) return; // 正常关停，不自举
    log(`[api][告警] provider-proxy 意外退出(code=${code}, signal=${signal})，3s 后自举重试；期间 Pi 直连 Provider`);
    if (!proxyRespawnGuard) {
      proxyRespawnGuard = true;
      setTimeout(() => {
        proxyRespawnGuard = false;
        ensureProxy(config, log).catch((e) => log(`[api][告警] provider-proxy 自举重试失败：${e.message}`));
      }, 3000);
    }
  });
  // 等待就绪（最多 15s）
  for (let i = 0; i < 30; i++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      if ((await fetch(url)).ok) {
        log("[api] provider-proxy 就绪");
        return child;
      }
    } catch {
      /* retry */
    }
  }
  log("[api][告警] provider-proxy 未在预期时间内就绪，Pi 将直连 Provider");
  return child;
}

// 每 Pod 单一 Pi worker（Pi 单实例约束）：所有 ask 路由到同一 worker，
// 由 PiWorker 内 _askLock 串行化。不再按 sessionId 派生独立 Pi（会硬崩）。
function buildRealPool(config) {
  const pool = new SessionPool({
    maxSessions: config.maxSessions,
    idleTtlMs: config.idleTtlMs,
    log: (m) => console.log(m),
    workerFactory: () =>
      new PiWorker({
        nodeBin: config.nodeBin,
        model: config.model,
        systemPrompt: config.systemPrompt,
        sessionDir: config.sessionDir,
        timeoutMs: config.askTimeoutMs,
        log: (m) => console.log(m),
      }),
  });
  pool.start();
  return pool;
}

export function startApiServer({
  config = makeConfig(),
  pool,
  log = console.log,
} = {}) {
  const usePool = pool || buildRealPool(config);
  const handler = createApiHandler({ pool: usePool, config, log });
  // 在途请求计数（供优雅关停排水）
  let activeReqs = 0;
  const server = createServer((req, res) => {
    activeReqs++;
    Promise.resolve()
      .then(() => handler(req, res))
      .catch((e) => {
        try {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: false,
              error: "internal_error",
              reason: String(e?.message || e),
            }),
          );
        } catch {
          /* noop */
        }
      })
      .finally(() => {
        activeReqs--;
      });
  });
  let proxyChild = null;

  server.listen(config.port, config.host, async () => {
    log(
      `[api] Medical Agentic RAG API  → http://${config.host}:${config.port}/`,
    );
    if (config.apiToken) {
      log(`[api] 鉴权已启用（Bearer）。`);
    } else if (isLocalHost(config.host) || process.env.API_AUTH_DISABLED === "1") {
      log(`[api][注意] 未设 API_TOKEN，接口仅本机回环开放（API_AUTH_DISABLED=${process.env.API_AUTH_DISABLED === "1"}）。`);
    } else {
      log(`[api][⚠️ 安全] 未设 API_TOKEN 且绑定非本机(${config.host})，接口将对全网开放（401 拒绝）。生产须设 API_TOKEN 或改绑 127.0.0.1。`);
    }
    // 预热单 Pi worker（best-effort）：失败不阻断服务，首问会自动重建；
    // 成功则就绪探针立即可过，Pod 启动即能服务。
    try {
      await usePool.warmup();
      log(`[api] 单 Pi worker 预热完成（/readyz 可过）`);
    } catch (e) {
      log(`[api][告警] Pi worker 预热失败，将延至首问重建：${e.message}`);
    }
    proxyChild = await ensureProxy(config, log);
  });

  let shuttingDown = false;
  const shutdown = async (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[api] 收到 ${sig}，优雅关停中…`);
    server.close(() => {}); // 停收新连接
    // 排水：等待在途请求完成（最多 API_DRAIN_MS），避免中断长尾 ask
    const drainMs = Number(process.env.API_DRAIN_MS || 30000);
    const t0 = Date.now();
    while (activeReqs > 0 && Date.now() - t0 < drainMs) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (activeReqs > 0)
      log(`[api][告警] 排水超时，仍有 ${activeReqs} 个在途请求，强制关停`);
    // 硬杀整棵 Pi 子树（dispose），根治孤儿 Pi 持全局 KB 锁饿死新实例
    try {
      await usePool.dispose();
    } catch {
      /* noop */
    }
    if (proxyChild)
      try {
        proxyChild.kill("SIGTERM");
      } catch {
        /* noop */
      }
    log(`[api] 关停完成`);
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGQUIT", () => shutdown("SIGQUIT"));

  return { server, pool: usePool, config };
}

// 仅当显式开关 MEDICAL_API_RUN=1 时启动真实服务（避免被测试/其他模块导入时误拉起 Pi）
if (process.env.MEDICAL_API_RUN === "1") {
  startApiServer({ config: makeConfig() });
}
