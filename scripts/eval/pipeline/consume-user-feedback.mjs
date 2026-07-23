// consume-user-feedback.mjs
// 用户反馈消费 —— 读取显式反馈 ndjson 并聚合为热点摘要。
//
// 用法:
//   node scripts/eval/pipeline/consume-user-feedback.mjs           最新反馈摘要
//   node scripts/eval/pipeline/consume-user-feedback.mjs --days 7  回溯 7 天
//   node scripts/eval/pipeline/consume-user-feedback.mjs --json    输出 JSON

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const LOGS_DIR = join(ROOT, ".pi", "logs");

const args = process.argv.slice(2);
const DAYS = Number(args.find((a) => a.startsWith("--days="))?.split("=")[1] || 1);
const AS_JSON = args.includes("--json");

function loadFeedback(days) {
  if (!existsSync(LOGS_DIR)) return [];
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("feedback-") && f.endsWith(".ndjson"))
    .sort()
    .reverse()
    .slice(0, days);

  const entries = [];
  for (const f of files) {
    try {
      const lines = readFileSync(join(LOGS_DIR, f), "utf-8").trim().split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          entries.push(JSON.parse(line));
        } catch { /* skip bad lines */ }
      }
    } catch { /* skip bad files */ }
  }
  return entries;
}

function main() {
  const entries = loadFeedback(DAYS);
  if (entries.length === 0) {
    console.log(`无用户反馈记录（${LOGS_DIR}/feedback-*.ndjson）`);
    process.exit(0);
  }

  const total = entries.length;
  const helpful = entries.filter((e) => e.rating === 1).length;
  const unhelpful = entries.filter((e) => e.rating === 0).length;
  const withComment = entries.filter((e) => e.comment).length;

  // 按查询词聚合热点
  const queryHot = new Map();
  for (const e of entries) {
    if (e.rating === 0) {
      const q = (e.query || "").slice(0, 30);
      queryHot.set(q, (queryHot.get(q) || 0) + 1);
    }
  }
  const hotspots = [...queryHot.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  if (AS_JSON) {
    console.log(JSON.stringify({
      total, helpful, unhelpful, withComment,
      satisfactionRate: total > 0 ? (helpful / total) : 0,
      hotspots: hotspots.map(([q, c]) => ({ query: q, unhelpfulCount: c })),
    }, null, 2));
    process.exit(0);
  }

  console.log("━━━ 用户反馈摘要 ━━━\n");
  console.log(`  统计周期: 最近 ${DAYS} 天`);
  console.log(`  总反馈数: ${total}`);
  console.log(`  有帮助:   ${helpful} (${total > 0 ? (helpful / total * 100).toFixed(0) : 0}%)`);
  console.log(`  无帮助:   ${unhelpful} (${total > 0 ? (unhelpful / total * 100).toFixed(0) : 0}%)`);
  console.log(`  满意度:   ${total > 0 ? (helpful / total * 100).toFixed(0) : 0}%`);
  console.log(`  含评论:   ${withComment}`);

  if (hotspots.length > 0) {
    console.log(`\n⚠ 低满意度热点查询:`);
    for (const [q, c] of hotspots) {
      console.log(`  ${q.padEnd(30)} ${c} 次无帮助`);
    }
  }

  console.log(`\n💡 建议: 将低满意度查询纳入 gold-answers 评测集`);
  console.log(`   node scripts/eval/pipeline/consume-user-feedback.mjs --days 7 --json`);
}

main();
