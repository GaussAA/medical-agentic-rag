// scripts/ops/audit-verify.mjs
// 审计链验证与查询 CLI。
//
// 命令：
//   verify [date]          验证审计链完整性（省略 date 则验全部）
//   query [--action 动作]   查询审计日志（--limit 50 --offset 0）
//   status                 审计系统状态摘要
//
// 用法：
//   node scripts/ops/audit-verify.mjs verify
//   node scripts/ops/audit-verify.mjs query --action patient
//   node scripts/ops/audit-verify.mjs status

import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/audit-chain.mjs")).href;
const { verifyChain, queryAuditLog } = await import(MOD);

function fmt(t) {
  return new Date(t).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" });
}

async function cmdVerify(args) {
  const date = args[0] || null;
  console.log(`验证审计链${date ? ` (${date})` : "（全部文件）"}...\n`);

  const t0 = performance.now();
  const result = verifyChain(date);
  const ms = (performance.now() - t0).toFixed(1);

  console.log(`检查: ${result.total} 条`);
  console.log(`有效: ${result.valid}`);
  console.log(`无效: ${result.invalid}`);
  console.log(`耗时: ${ms}ms\n`);

  if (result.invalid > 0) {
    console.log("⚠ 发现篡改或损坏:");
    for (const d of result.details) {
      console.log(`  [${d.date}] 行 ${d.line}  ${d.action || "?"}`);
      console.log(`    原因: ${d.reason}`);
    }
    process.exit(1);
  } else {
    console.log("✓ 审计链完整，未检测到篡改");
    if (result.lastHash) {
      console.log(`  链尾哈希: ${result.lastHash.slice(0, 16)}...`);
    }
  }
}

function cmdQuery(args) {
  let action = null;
  let limit = 50;
  let offset = 0;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--action") action = args[++i];
    if (args[i] === "--limit") limit = parseInt(args[++i], 10);
    if (args[i] === "--offset") offset = parseInt(args[++i], 10);
  }

  const results = queryAuditLog({ action, limit, offset });
  console.log(`审计查询 (action=${action || "*"}, limit=${limit}, offset=${offset}):\n`);

  if (results.length === 0) {
    console.log("（无匹配记录）");
    return;
  }

  for (const r of results) {
    const chain = r.hash ? ` [✓链]` : ` [旧]`;
    console.log(`${fmt(r.t)} ${r.action}${chain}`);
    if (r.fields) console.log(`  字段: ${r.fields.join(", ")}`);
    if (r.prevHash) console.log(`  前驱: ${r.prevHash.slice(0, 12)}...`);
    if (r.hash) console.log(`  哈希: ${r.hash.slice(0, 12)}...`);
    console.log();
  }
}

function cmdStatus() {
  const result = verifyChain();
  const today = new Date().toISOString().slice(0, 10);
  const todayFile = join(ROOT, ".pi", "logs", `audit-${today}.ndjson`);

  console.log("审计系统状态:\n");
  console.log(`  审计文件: ${existsSync(todayFile) ? todayFile : "（今日空）"}`);
  console.log(`  总条目数: ${result.total}`);
  console.log(`  链尾哈希: ${result.lastHash ? result.lastHash.slice(0, 16) + "..." : "（无）"}`);
  console.log(`  完整性: ${result.ok ? "✓ 完整" : "✗ 被篡改"}`);
  if (result.details.length > 0) {
    console.log(`  异常: ${result.details.length} 条`);
  }
}

async function main() {
  const cmd = process.argv[2];
  const args = process.argv.slice(3);

  switch (cmd) {
    case "verify":
      await cmdVerify(args);
      break;
    case "query":
      cmdQuery(args);
      break;
    case "status":
      cmdStatus();
      break;
    default:
      console.log(`审计链工具

命令:
  verify [date]   验证审计链完整性
  query [opts]    查询审计日志
  status          系统状态

选项:
  --action  str   按动作过滤
  --limit   num   返回条数（默认 50）
  --offset  num   偏移（默认 0）

用法:
  node scripts/ops/audit-verify.mjs verify
  node scripts/ops/audit-verify.mjs query --action patient --limit 10
  node scripts/ops/audit-verify.mjs status`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
