#!/usr/bin/env node
// ============================================================
// loadtest.mjs — API 压力测试
//
// 向 /api/v1/ask 发送并发请求，测量吞吐量、响应时间、错误率。
//
// 用法：
//   node scripts/ops/loadtest.mjs                          # 默认: 5并发×10轮
//   node scripts/ops/loadtest.mjs --concurrency 10 --rounds 20
//   node scripts/ops/loadtest.mjs --json                    # JSON 报告输出
//   node scripts/ops/loadtest.mjs --duration 60             # 持续 60 秒
//
// 依赖：API 服务运行在 localhost:8080
// ============================================================
const API = process.env.LOADTEST_API_URL || "http://localhost:8080/api/v1/ask";

const args = process.argv.slice(2);
const CONCURRENCY = args.includes("--concurrency")
  ? parseInt(args[args.indexOf("--concurrency") + 1], 10) || 5
  : 5;
const ROUNDS = args.includes("--rounds")
  ? parseInt(args[args.indexOf("--rounds") + 1], 10) || 10
  : 10;
const DURATION = args.includes("--duration")
  ? parseInt(args[args.indexOf("--duration") + 1], 10) || 60
  : null;
const JSON_OUT = args.includes("--json");

// 测试问题池（避免缓存命中影响测量）
const QUESTIONS = [
  "高血压患者长期管理的推荐方案是什么？",
  "2型糖尿病的空腹血糖控制目标是多少？",
  "儿童支原体肺炎的首选抗生素是什么？",
  "乳腺癌术后辅助化疗的指征有哪些？",
  "慢性阻塞性肺疾病稳定期的管理策略是什么？",
  "急性心肌梗死后的二级预防用药有哪些？",
  "心房颤动患者的抗凝治疗选择？",
  "骨质疏松症的诊断标准和治疗方案？",
  "脑卒中急性期的血压管理目标？",
  "慢性肾脏病 3 期的饮食管理建议？",
  "类风湿关节炎的达标治疗策略？",
  "甲状腺功能亢进症的药物选择？",
];

async function sendRequest(question) {
  const start = Date.now();
  try {
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, timeoutMs: 60000 }),
      signal: AbortSignal.timeout(65000),
    });
    const elapsed = Date.now() - start;
    const data = await res.json();
    return {
      ok: data.ok,
      elapsed,
      status: res.status,
      error: data.reason || null,
      guardHits: data.safety?.guardHits?.length || 0,
    };
  } catch (err) {
    return {
      ok: false,
      elapsed: Date.now() - start,
      status: 0,
      error: err.message || String(err),
      guardHits: 0,
    };
  }
}

async function main() {
  console.log("=".repeat(70));
  console.log("  API 压力测试");
  console.log(`  并发: ${CONCURRENCY}  轮次: ${DURATION ? "持续" + DURATION + "s" : ROUNDS}`);
  console.log(`  API: ${API}`);
  console.log("=".repeat(70));

  const results = [];
  const totalRequests = DURATION ? null : CONCURRENCY * ROUNDS;
  const startTime = Date.now();
  const endTime = DURATION ? startTime + DURATION * 1000 : null;
  let completed = 0;
  let errors = 0;

  let round = 0;
  while (true) {
    if (endTime && Date.now() >= endTime) break;
    if (!endTime && round >= ROUNDS) break;

    const batch = Math.min(
      CONCURRENCY,
      endTime ? CONCURRENCY : ROUNDS - round,
    );

    const promises = [];
    for (let i = 0; i < batch; i++) {
      const q = QUESTIONS[(round * CONCURRENCY + i) % QUESTIONS.length];
      promises.push(sendRequest(q));
    }

    // 进度指示
    process.stdout.write(`.`);

    const batchResults = await Promise.all(promises);
    for (const r of batchResults) {
      results.push(r);
      completed++;
      if (!r.ok) errors++;
    }

    round += endTime ? 1 : 1;
  }

  const totalTime = (Date.now() - startTime) / 1000;
  const okResults = results.filter((r) => r.ok);
  const elapsedList = okResults.map((r) => r.elapsed);

  // 百分位
  const sorted = [...elapsedList].sort((a, b) => a - b);
  const p50 = sorted[Math.floor(sorted.length * 0.5)] || 0;
  const p90 = sorted[Math.floor(sorted.length * 0.9)] || 0;
  const p99 = sorted[Math.floor(sorted.length * 0.99)] || 0;
  const avg = elapsedList.length > 0
    ? elapsedList.reduce((a, b) => a + b, 0) / elapsedList.length
    : 0;

  console.log("\n");
  console.log("=".repeat(70));
  console.log("  压测报告");
  console.log("=".repeat(70));
  console.log(`  总请求  : ${completed}`);
  console.log(`  成功    : ${okResults.length}`);
  console.log(`  失败    : ${errors}`);
  console.log(`  成功率  : ${((okResults.length / completed) * 100).toFixed(1)}%`);
  console.log(`  总耗时  : ${totalTime.toFixed(1)}s`);
  console.log(`  吞吐量  : ${(completed / totalTime).toFixed(1)} req/s`);
  console.log(`\n  响应延迟:`);
  console.log(`    均值   : ${avg.toFixed(0)}ms`);
  console.log(`    P50    : ${p50}ms`);
  console.log(`    P90    : ${p90}ms`);
  console.log(`    P99    : ${p99}ms`);
  console.log(`    最慢   : ${sorted[sorted.length - 1] || 0}ms`);

  if (JSON_OUT) {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const outDir = path.join(process.cwd(), "tests", "reports");
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(
      path.join(outDir, "loadtest-report.json"),
      JSON.stringify(
        {
          ts: new Date().toISOString(),
          config: { concurrency: CONCURRENCY, rounds: ROUNDS, duration: DURATION },
          summary: {
            total: completed,
            succeeded: okResults.length,
            failed: errors,
            successRate: ((okResults.length / completed) * 100).toFixed(1),
            totalTimeSec: totalTime.toFixed(1),
            throughput: (completed / totalTime).toFixed(1),
            latency: { avg: avg.toFixed(0), p50, p90, p99, max: sorted[sorted.length - 1] || 0 },
          },
          results,
        },
        null,
        2,
      ),
    );
    console.log(`\n  报告已写入: tests/reports/loadtest-report.json`);
  }
}

main().catch((err) => {
  console.error("[loadtest] 执行失败:", err);
  process.exit(1);
});
