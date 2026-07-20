// feedback-loop.mjs (CLI)
// 维度五·持续反馈优化 —— 运行时信号 → 系统性薄弱点 → 改进建议队列。
// 纯聚合，不烧 LLM；默认不阻断 CI（--strict 时 high>0 退出 1）。
//
// 用法: node scripts/ops/feedback-loop.mjs [--strict] [--out <path>]

import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildFeedbackQueue, writeFeedbackQueue } from "../../.pi/extensions/lib/feedback-loop.mjs";

function parseArgs(argv) {
  const a = { strict: false, out: undefined };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--strict") a.strict = true;
    else if (argv[i] === "--out" && argv[i + 1]) a.out = argv[++i];
  }
  return a;
}

function printSummary(q) {
  const s = q.summary;
  console.log("\n═══ 维度五·反馈闭环摘要 ═══");
  console.log(`信号总数: ${s.totalSignals}  (高 ${s.high} / 中 ${s.medium} / 低 ${s.low})`);
  console.log(`系统性热点: ${s.hotspotCount}`);
  if (s.hotspotCount > 0) {
    console.log("\nTop 热点与建议:");
    for (const h of q.hotspots.slice(0, 8)) {
      console.log(`  [${h.severity.toUpperCase()}] ${h.type} ×${h.count}${h.guides?.length ? "  «" + h.guides.join("/") + "»" : ""}`);
      console.log(`     → ${h.suggestion}`);
    }
  } else {
    console.log("  无显著系统性热点，闭环健康。");
  }
  console.log(`\n队列已写出: ${q._outPath || "(内存)"}`);
}

const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const args = parseArgs(process.argv);
    const queue = buildFeedbackQueue({});
    const outPath = args.out || undefined;
    const written = writeFeedbackQueue(queue, outPath);
    queue._outPath = written;
    printSummary(queue);
    if (args.strict && queue.summary.high > 0) {
      console.error(`\n[feedback-loop] --strict: 存在 ${queue.summary.high} 个高危信号，退出码 1`);
      process.exit(1);
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[feedback-loop] 致命错误: ${e?.stack || e}\n`);
    process.exit(1);
  }
}
