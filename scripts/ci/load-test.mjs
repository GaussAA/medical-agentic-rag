#!/usr/bin/env node
/**
 * load-test.mjs — 医疗 Agentic RAG T8 HTTP API 并发压测摸底
 *
 * 设计目标：零外部依赖，对 T8 服务做分层容量摸底。
 *   - healthz 层：纯 HTTP + 会话池健康检查，不耗 LLM、不占会话池，测 Node 服务承载上限。
 *   - ask 层：真实触发 Pi RPC + LLM，按请求序号分配唯一 sessionId 以打满会话池，
 *             观察端到端延迟 / 池饱和(429) / 熔断行为。
 *
 * 用法：
 *   node scripts/ops/load-test.mjs --target healthz --base http://127.0.0.1:8088 --concurrency 50 --requests 500
 *   node scripts/ops/load-test.mjs --target ask    --base http://127.0.0.1:8088 --concurrency 4 --requests 8 \
 *        --token <tok> --out tests/reports/load-ask.json
 */
import http from "node:http";
import { performance } from "node:perf_hooks";
import { writeFileSync } from "node:fs";

function parseArgs(argv) {
  const o = {
    target: "healthz",
    base: "http://127.0.0.1:8080",
    concurrency: 10,
    requests: 100,
    timeoutMs: 120000,
    token: "",
    out: "",
    sessionPrefix: "lt",
    question: "2型糖尿病患者的空腹血糖控制目标是多少？",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--target") o.target = argv[++i];
    else if (a === "--base") o.base = argv[++i].replace(/\/$/, "");
    else if (a === "--concurrency") o.concurrency = Number(argv[++i]);
    else if (a === "--requests") o.requests = Number(argv[++i]);
    else if (a === "--timeout-ms") o.timeoutMs = Number(argv[++i]);
    else if (a === "--token") o.token = argv[++i];
    else if (a === "--out") o.out = argv[++i];
    else if (a === "--session-prefix") o.sessionPrefix = argv[++i];
    else if (a === "--question") o.question = argv[++i];
  }
  return o;
}

function fire(url, { method, body, token, timeoutMs }) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const headers = { "Content-Type": "application/json", Accept: "application/json" };
    if (token) headers["Authorization"] = `Bearer ${token}`;
    const start = performance.now();
    const req = http.request(
      u,
      { method, headers, timeout: timeoutMs },
      (res) => {
        let bytes = 0;
        res.on("data", (c) => (bytes += c.length));
        res.on("end", () =>
          resolve({ status: res.statusCode, ms: performance.now() - start, bytes, ok: res.statusCode < 400 })
        );
      }
    );
    req.on("error", (e) => resolve({ status: 0, ms: performance.now() - start, bytes: 0, ok: false, error: e.message }));
    req.on("timeout", () => req.destroy(new Error("timeout")));
    if (body) req.write(body);
    req.end();
  });
}

function pct(sorted, p) {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  const isAsk = o.target === "ask";
  const path = isAsk ? "/api/v1/ask" : "/healthz";
  const url = o.base + path;
  const method = isAsk ? "POST" : "GET";

  console.log(`\n[load-test] target=${o.target} method=${method} url=${url}`);
  console.log(`[load-test] concurrency=${o.concurrency} requests=${o.requests} timeout=${o.timeoutMs}ms\n`);

  const samples = [];
  let next = 0;
  let done = 0;
  const t0 = performance.now();
  const workers = Array.from({ length: o.concurrency }, async () => {
    while (true) {
      const i = next++;
      if (i >= o.requests) break;
      // ask 模式：每个请求独立 sessionId，真正打满会话池（而非复用共享 worker）
      const b = isAsk ? JSON.stringify({ question: o.question, sessionId: `${o.sessionPrefix}-${i}` }) : null;
      const r = await fire(url, { method, body: b, token: o.token, timeoutMs: o.timeoutMs });
      done++;
      samples.push({ i, ...r });
      if (done % 10 === 0 || done === o.requests)
        process.stdout.write(`  … ${done}/${o.requests}  last=${r.ms.toFixed(0)}ms status=${r.status}\r`);
    }
  });
  await Promise.all(workers);
  const t1 = performance.now();
  const elapsed = (t1 - t0) / 1000;

  const lat = samples.map((s) => s.ms).sort((a, b) => a - b);
  const ok = samples.filter((s) => s.ok);
  const errs = samples.filter((s) => !s.ok);
  const statusDist = {};
  for (const s of samples) statusDist[s.status] = (statusDist[s.status] || 0) + 1;
  const qps = done / elapsed;

  console.log("\n──────── 汇总 ────────");
  console.log(`请求数         : ${done}`);
  console.log(`成功/失败       : ${ok.length} / ${errs.length} (${(errs.length / done * 100).toFixed(1)}% 错误率)`);
  console.log(`总耗时         : ${elapsed.toFixed(2)}s`);
  console.log(`吞吐(QPS)      : ${qps.toFixed(2)}`);
  console.log(`状态码分布     : ${JSON.stringify(statusDist)}`);
  console.log(`延迟(ms) min   : ${lat[0]?.toFixed(0)}`);
  console.log(`延迟(ms) p50   : ${pct(lat, 50).toFixed(0)}`);
  console.log(`延迟(ms) p95   : ${pct(lat, 95).toFixed(0)}`);
  console.log(`延迟(ms) p99   : ${pct(lat, 99).toFixed(0)}`);
  console.log(`延迟(ms) max   : ${lat[lat.length - 1]?.toFixed(0)}`);

  const report = {
    target: o.target,
    base: o.base,
    concurrency: o.concurrency,
    requests: done,
    elapsedSec: elapsed,
    qps,
    errorRate: errs.length / done,
    statusDist,
    latencyMs: {
      min: lat[0],
      p50: pct(lat, 50),
      p95: pct(lat, 95),
      p99: pct(lat, 99),
      max: lat[lat.length - 1],
    },
    samples: o.out ? samples : undefined,
  };
  if (o.out) {
    writeFileSync(o.out, JSON.stringify(report, null, 2));
    console.log(`\n[load-test] 明细已写 ${o.out}`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
