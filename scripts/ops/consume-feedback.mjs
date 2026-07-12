// consume-feedback.mjs (CLI)
// 维度五·反馈闭环消费端：读取 feedback-queue.json → 跳过已解决 → 派生 gold 候选
// → 落回灌记录 + 候选清单。绝不修改受控 gold-answers.json（候选需人工审阅后并入）。
//
// 用法: node scripts/ops/consume-feedback.mjs [--strict] [--queue <path>] [--candidates <path>]
//   --strict        若存在 phi_noncompliant 高危信号 → 退出码 1（合规阻断）
//   --queue <path>  指定队列文件（默认 logs/feedback-queue.json）
//   --candidates <path> 候选输出路径（默认 tests/reports/gold-candidates.json）

import { resolve, join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import {
  readFeedbackQueue,
  consumeFeedback,
  writeConsumed,
} from "../../.pi/extensions/lib/feedback-loop.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function parseArgs(argv) {
  const a = { strict: false, queue: undefined, candidates: undefined };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--strict") a.strict = true;
    else if (argv[i] === "--queue" && argv[i + 1]) a.queue = argv[++i];
    else if (argv[i] === "--candidates" && argv[i + 1]) a.candidates = argv[++i];
  }
  return a;
}

function printSummary(rec) {
  console.log("\n═══ 维度五·反馈消费回灌摘要 ═══");
  if (!rec.consumed) {
    console.log("  无可消费队列（logs/feedback-queue.json 缺失或为空），闭环暂歇。");
    return;
  }
  console.log(`热点总数: ${rec.totalHotspots}  开放: ${rec.openHotspots}  已解决跳过: ${rec.resolvedSkipped}`);
  console.log(`派生 gold 候选: ${rec.goldCandidates.length}`);
  for (const c of rec.goldCandidates.slice(0, 8)) {
    console.log(`  [${c.severity.toUpperCase()}] ${c.id} «${c.department}» ×${c.count}`);
    console.log(`     → ${c.rationale}`);
  }
  if (rec.goldCandidates.length === 0) console.log("  无评测类薄弱点，gold 候选为空。");
}

const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

if (isMain) {
  try {
    const args = parseArgs(process.argv);
    const rec = consumeFeedback({ queuePath: args.queue });
    const consumedPath = writeConsumed(rec);
    printSummary(rec);

    // 候选清单合并写出（去重，绝不碰受控 gold-answers.json）
    if (rec.goldCandidates.length) {
      const candPath =
        args.candidates || join(ROOT, "tests", "reports", "gold-candidates.json");
      let merged = [];
      if (existsSync(candPath)) {
        try {
          merged = JSON.parse(readFileSync(candPath, "utf-8"));
          if (!Array.isArray(merged)) merged = [];
        } catch {
          merged = [];
        }
      }
      const have = new Set(merged.map((c) => c.id));
      let added = 0;
      for (const c of rec.goldCandidates) {
        if (!have.has(c.id)) {
          merged.push(c);
          have.add(c.id);
          added++;
        }
      }
      mkdirSync(dirname(candPath), { recursive: true });
      writeFileSync(candPath, JSON.stringify(merged, null, 2), "utf-8");
      console.log(`\n候选已合并至: ${candPath}（新增 ${added}，累计 ${merged.length}）`);
    }
    console.log(`\n回灌记录: ${consumedPath}`);

    // --strict：PHI 合规高危阻断
    if (args.strict) {
      const q = readFeedbackQueue(args.queue);
      const phiHigh = (q?.hotspots || []).some(
        (h) => h.type === "phi_noncompliant" && h.severity === "high",
      );
      if (phiHigh) {
        console.error("\n[consume-feedback] --strict: 检出 PHI 合规高危信号，退出码 1");
        process.exit(1);
      }
    }
    process.exit(0);
  } catch (e) {
    process.stderr.write(`[consume-feedback] 致命错误: ${e?.stack || e}\n`);
    process.exit(1);
  }
}
