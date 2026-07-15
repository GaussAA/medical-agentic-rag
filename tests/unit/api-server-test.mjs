// tests/unit/api-server-test.mjs
// T8 API 服务单测（不依赖真实 Pi / LLM：注入 mock pool）
//
// 运行：node --test tests/unit/api-server-test.mjs
// 覆盖：ask 结构化返回 / 入参校验 / 鉴权 / 模型热切换 / 会话列表 / 熔断触发 / 指标 / assembler

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createApiHandler, makeConfig } from "../../scripts/service/api-server.mjs";
import { assembleResult } from "../../scripts/service/pi-bridge.mjs";
import { CircuitBreaker, CircuitOpenError, retry } from "../../scripts/service/circuit-breaker.mjs";

function makeMockPool({ askImpl } = {}) {
  const calls = { ask: 0, setModel: 0, models: 0, sessions: 0 };
  return {
    _calls: calls,
    async ask(sessionId, prompt, opts) {
      calls.ask++;
      if (askImpl) return askImpl(sessionId, prompt, opts);
      return {
        ok: true,
        answer: "这是示例回答，依据《某诊疗指南》推荐……",
        citations: [{ source: "nhc", title: "某诊疗指南(2023)", section: "3.2", snippet: "推荐…" }],
        evidence: [{ tool: "rag_search", summary: "命中 2 条相关段落" }],
        safety: { guardHits: [], blocked: false },
        stats: { turns: 1, toolCalls: 1 },
        model: "sensenova/sensenova-6.7-flash-lite",
        traceId: opts?.traceId || "t",
        durationMs: 12,
      };
    },
    async setModel(p, m) { calls.setModel++; return `${p}/${m}`; },
    async getAvailableModels() { calls.models++; return [{ provider: "sensenova", id: "sensenova-6.7-flash-lite" }]; },
    listSessions() { calls.sessions++; return { defaultAlive: true, sessions: [{ sessionId: "s1", alive: true, idleMs: 1 }] }; },
    async stopAll() {},
  };
}

function startServer(handler) {
  const server = createServer(handler);
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function jsonPost(server, path, body, headers = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* noop */ }
  return { status: res.status, json, text };
}

async function jsonGet(server, path, headers = {}) {
  const port = server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* noop */ }
  return { status: res.status, json, text };
}

test("assembleResult: 抽取最终回答/引用/护栏", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "问题" }] },
    { role: "toolResult", toolName: "rag_search", content: [{ type: "text", text: '来源：中国糖尿病防治指南（2024版） 章节：表7 综合控制目标\n命中片段：空腹血糖 4.4~7.0 mmol/L' }] },
    { role: "toolResult", toolName: "scope_guard", content: [{ type: "text", text: "拒绝：超出内科范围" }] },
    { role: "assistant", content: [{ type: "text", text: "最终答案在此" }] },
  ];
  const out = assembleResult({ messages, entries: [], stats: { turns: 1 }, model: "p/m", traceId: "x", durationMs: 5 });
  assert.equal(out.answer, "最终答案在此");
  assert.ok(out.citations.some((c) => c.source.includes("中国糖尿病防治指南（2024版）")));
  assert.ok(out.evidence.some((e) => e.tool === "rag_search"));
  assert.ok(out.evidence.some((e) => e.tool === "scope_guard"));
  assert.ok(out.safety.guardHits.includes("scope_guard"));
  assert.equal(out.safety.blocked, true); // 含"拒绝"
});

test("POST /api/v1/ask 返回结构化结果", async () => {
  const pool = makeMockPool();
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "" }) });
  const server = await startServer(handler);
  try {
    const { status, json } = await jsonPost(server, "/api/v1/ask", { question: "高血压怎么治？" });
    assert.equal(status, 200);
    assert.equal(json.ok, true);
    assert.match(json.answer, /示例回答/);
    assert.ok(Array.isArray(json.citations));
    assert.ok(Array.isArray(json.evidence));
    assert.ok(json.safety && typeof json.safety.blocked === "boolean");
    assert.ok(json.traceId);
  } finally { server.close(); }
});

test("POST /api/v1/ask 缺 question → 400", async () => {
  const pool = makeMockPool();
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "" }) });
  const server = await startServer(handler);
  try {
    const { status, json } = await jsonPost(server, "/api/v1/ask", {});
    assert.equal(status, 400);
    assert.equal(json.ok, false);
    assert.equal(pool._calls.ask, 0);
  } finally { server.close(); }
});

test("鉴权：无 token 拒绝、带 token 放行", async () => {
  const pool = makeMockPool();
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "topsecret" }) });
  const server = await startServer(handler);
  try {
    const noAuth = await jsonPost(server, "/api/v1/ask", { question: "x" });
    assert.equal(noAuth.status, 401);
    const withAuth = await jsonPost(server, "/api/v1/ask", { question: "x" }, { Authorization: "Bearer topsecret" });
    assert.equal(withAuth.status, 200);
  } finally { server.close(); }
});

test("POST /api/v1/model 热切换", async () => {
  const pool = makeMockPool();
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "" }) });
  const server = await startServer(handler);
  try {
    const { status, json } = await jsonPost(server, "/api/v1/model", { provider: "deepseek", model: "deepseek-v4-flash" });
    assert.equal(status, 200);
    assert.equal(json.model, "deepseek/deepseek-v4-flash");
    assert.equal(pool._calls.setModel, 1);
  } finally { server.close(); }
});

test("GET /api/v1/models 与 /api/v1/sessions", async () => {
  const pool = makeMockPool();
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "" }) });
  const server = await startServer(handler);
  try {
    const m = await jsonGet(server, "/api/v1/models");
    assert.equal(m.status, 200);
    assert.ok(Array.isArray(m.json.models));
    const s = await jsonGet(server, "/api/v1/sessions");
    assert.equal(s.status, 200);
    assert.equal(s.json.defaultAlive, true);
  } finally { server.close(); }
});

test("GET /healthz 与 /metrics", async () => {
  const pool = makeMockPool();
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "" }) });
  const server = await startServer(handler);
  try {
    const h = await jsonGet(server, "/healthz");
    assert.equal(h.status, 200);
    assert.ok(["ok", "degraded"].includes(h.json.status));
    const mt = await jsonGet(server, "/metrics");
    assert.equal(mt.status, 200);
    assert.match(mt.text, /medical_rag_up/);
  } finally { server.close(); }
});

test("熔断：连续失败达阈值后返回 429", async () => {
  const pool = makeMockPool({ askImpl: async () => { throw new Error("Pi boom"); } });
  const handler = createApiHandler({ pool, config: makeConfig({ apiToken: "" }) });
  const server = await startServer(handler);
  try {
    let saw500 = false, saw429 = false;
    for (let i = 0; i < 6; i++) {
      const r = await jsonPost(server, "/api/v1/ask", { question: "x" });
      if (r.status === 500) saw500 = true;
      if (r.status === 429) saw429 = true;
    }
    assert.ok(saw500, "应出现若干 500");
    assert.ok(saw429, "熔断打开后应出现 429");
  } finally { server.close(); }
});

test("CircuitBreaker: closed→open→half-open→closed（注入时钟）", async () => {
  let now = 1000;
  const cb = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 5000, successThreshold: 2, now: () => now });
  const ok = async () => cb.exec(async () => "fine");
  const bad = async () => cb.exec(async () => { throw new Error("x"); });

  assert.equal(cb.state, "closed");
  await assert.rejects(bad());
  await assert.rejects(bad());
  await assert.rejects(bad());
  assert.equal(cb.state, "open"); // 第3次失败触发
  // 冷却期内拒绝（CircuitOpenError）
  await assert.rejects(bad(), CircuitOpenError);
  // 进入冷却后，下次调用翻 half-open
  now += 5000;
  assert.equal(await ok(), "fine");
  assert.equal(cb.state, "half-open");
  assert.equal(await ok(), "fine");
  assert.equal(cb.state, "closed");
});

test("retry: 退避后成功；不可重试即放弃", async () => {
  let attempts = 0;
  const flaky = () => { attempts++; if (attempts < 3) throw new Error("tmp"); return "ok"; };
  const r1 = await retry(flaky, { retries: 3, backoffMs: 1, factor: 1 });
  assert.equal(r1, "ok");
  assert.equal(attempts, 3);

  let a2 = 0;
  const fatal = () => { a2++; throw new Error("fatal"); };
  await assert.rejects(retry(fatal, { retries: 2, backoffMs: 1, factor: 1, shouldRetry: () => false }));
  assert.equal(a2, 1); // 不应重试
});
