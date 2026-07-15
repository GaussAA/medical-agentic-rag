// scripts/ops/pi-concurrency-test.mjs
// 隔离实验：直接造 2 个 PiWorker（不经 HTTP/API），并发 ask，
// 观察 Pi 是否真能并行，还是「单后端串行」导致 "Agent is already processing"。
//
// 用法：
//   node scripts/ops/pi-concurrency-test.mjs          # 默认：2 worker 共享 .pi/sessions
//   node scripts/ops/pi-concurrency-test.mjs distinct  # 2 worker 用不同 sessionDir（隔离共享状态）
//
// 退出码：0=两者都成功；非0=至少一方失败（打印双方结果）

import { join } from "node:path";
import { PiWorker } from "../service/pi-bridge.mjs";

const cwd = process.cwd();
const baseSessions = join(cwd, ".pi", "sessions");
const mode = process.argv[2] || "shared";
const Q = "2型糖尿病患者的空腹血糖控制目标是多少？简要回答。";

const dir1 = mode === "distinct" ? join(baseSessions, "ct1") : baseSessions;
const dir2 = mode === "distinct" ? join(baseSessions, "ct2") : baseSessions;

console.log(`[test] mode=${mode} dir1=${dir1} dir2=${dir2}`);

const w1 = new PiWorker({ model: "deepseek/deepseek-v4-flash", sessionDir: dir1, timeoutMs: 150000, log: () => {} });
const w2 = new PiWorker({ model: "deepseek/deepseek-v4-flash", sessionDir: dir2, timeoutMs: 150000, log: () => {} });

async function main() {
  console.log("[test] starting w1…");
  await w1.start();
  console.log("[test] w1 ready");
  console.log("[test] starting w2…");
  await w2.start();
  console.log("[test] w2 ready — 两 worker 均已就绪，开始并发 ask");

  const t0 = Date.now();
  const [r1, r2] = await Promise.allSettled([
    w1.ask(Q).catch((e) => ({ __error: e.message })),
    w2.ask(Q).catch((e) => ({ __error: e.message })),
  ]);
  const dt = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`[test] 并发结束，耗时 ${dt}s`);

  const out1 = r1.status === "fulfilled" ? r1.value : { __error: String(r1.reason) };
  const out2 = r2.status === "fulfilled" ? r2.value : { __error: String(r2.reason) };

  const ok1 = out1 && !out1.__error && out1.ok;
  const ok2 = out2 && !out2.__error && out2.ok;

  console.log("=== RESULT w1 ===");
  console.log(JSON.stringify({ ok: ok1, answerLen: out1?.answer?.length || 0, error: out1?.__error || null, durationMs: out1?.durationMs || null }, null, 2));
  console.log("=== RESULT w2 ===");
  console.log(JSON.stringify({ ok: ok2, answerLen: out2?.answer?.length || 0, error: out2?.__error || null, durationMs: out2?.durationMs || null }, null, 2));

  const pass = ok1 && ok2;
  console.log(`[test] 结论：${pass ? "两 Pi 进程可真并行（并发=2 可行）" : "单后端串行（并发>1 受限于 Pi 全局代理锁）"}`);
  await w1.stop().catch(() => {});
  await w2.stop().catch(() => {});
  process.exit(pass ? 0 : 1);
}

main().catch((e) => {
  console.error("[test][致命]", e);
  process.exit(2);
});
