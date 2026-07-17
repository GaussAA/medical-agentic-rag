// tests/unit/session-pool-test.mjs
// 会话池背压单测（不依赖真实 Pi / LLM：注入 mock worker）
//
// 运行：node --test tests/unit/session-pool-test.mjs
// 覆盖：容量内放行 / 超 maxSessions 立即 429 / inflight 异常归零 /
//       isFull() 状态 / listSessions 可观测字段 / 熔断 ignoreErrors 不污染

import { test } from "node:test";
import assert from "node:assert/strict";
import { SessionPool, PoolFullError } from "../../scripts/service/session-pool.mjs";
import { CircuitBreaker } from "../../scripts/service/circuit-breaker.mjs";

// 极简 mock PiWorker：start 同步完成，ask 行为可注入
function makeMockWorker({ askImpl, startImpl, alive = true } = {}) {
  return {
    _started: false,
    async start() {
      if (startImpl) return startImpl();
      this._started = true;
    },
    isAlive() {
      return alive && this._started;
    },
    async ask(q, opts) {
      if (askImpl) return askImpl(q, opts);
      return { ok: true, answer: "ok" };
    },
    async stop() {},
    async dispose() {},
  };
}

function makePool({ maxSessions = 8, workerOpts = {} } = {}) {
  return new SessionPool({
    maxSessions,
    workerFactory: () => makeMockWorker(workerOpts),
  });
}

test("容量内 ask 正常放行且 inflight 归零", async () => {
  const pool = makePool({ maxSessions: 4 });
  pool.start();
  const r = await pool.ask("s1", "q");
  assert.equal(r.answer, "ok");
  assert.equal(pool.inflight, 0);
  await pool.dispose();
});

test("超出 maxSessions 立即抛 PoolFullError(statusCode=429)", async () => {
  const pool = makePool({
    maxSessions: 1,
    workerOpts: { askImpl: async () => new Promise((res) => setTimeout(() => res({ ok: true, answer: "x" }), 50)) },
  });
  pool.start();
  const p1 = pool.ask("s1", "q1");
  const p2 = pool.ask("s2", "q2");
  const [r1, r2] = await Promise.allSettled([p1, p2]);
  assert.equal(r1.status, "fulfilled");
  assert.equal(r2.status, "rejected");
  assert.ok(r2.reason instanceof PoolFullError);
  assert.equal(r2.reason.statusCode, 429);
  assert.equal(pool.inflight, 0); // 结算后归零
  await pool.dispose();
});

test("worker 抛错时 inflight 仍归零（无计数泄漏）", async () => {
  const pool = makePool({
    maxSessions: 2,
    workerOpts: { askImpl: async () => { throw new Error("boom"); } },
  });
  pool.start();
  await assert.rejects(() => pool.ask("s", "q"));
  assert.equal(pool.inflight, 0);
  await pool.dispose();
});

test("isFull() 正确反映在途并发", async () => {
  let resolveAsk;
  const pending = new Promise((res) => (resolveAsk = res));
  const pool = makePool({
    maxSessions: 2,
    workerOpts: { askImpl: () => pending.then(() => ({ ok: true })) },
  });
  pool.start();
  const a = pool.ask("s1", "q");
  const b = pool.ask("s2", "q");
  await new Promise((r) => setImmediate(r)); // 让两个 await 都进入在途
  assert.equal(pool.inflight, 2);
  assert.equal(pool.isFull(), true);
  resolveAsk();
  await Promise.all([a, b]);
  assert.equal(pool.isFull(), false);
  assert.equal(pool.inflight, 0);
  await pool.dispose();
});

test("listSessions 暴露 inflight/maxSessions 可观测字段", () => {
  const pool = makePool({ maxSessions: 4 });
  const info = pool.listSessions();
  assert.equal(info.inflight, 0);
  assert.equal(info.maxSessions, 4);
});

test("熔断 ignoreErrors：PoolFullError 不计入下游故障、不误打 open", async () => {
  const breaker = new CircuitBreaker({
    failureThreshold: 3,
    cooldownMs: 1000,
    ignoreErrors: [PoolFullError],
  });
  const fn = async () => { throw new PoolFullError("满"); };
  for (let i = 0; i < 5; i++) {
    await assert.rejects(() => breaker.exec(fn));
  }
  // 5 次池满背压后，熔断器仍应为 closed（未误伤）
  assert.equal(breaker.state, "closed");
  assert.equal(breaker.totalFailures, 0);

  // 对照：真实下游故障仍应正常计数
  const breaker2 = new CircuitBreaker({ failureThreshold: 3, cooldownMs: 1000 });
  const bad = async () => { throw new Error("llm down"); };
  for (let i = 0; i < 3; i++) {
    await assert.rejects(() => breaker2.exec(bad));
  }
  assert.equal(breaker2.state, "open");
  assert.equal(breaker2.totalFailures, 3);
});
