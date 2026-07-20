#!/usr/bin/env node
/**
 * test-aggregate.mjs — npm test 聚合运行器
 *
 * 取代 package.json 中原 `&&` 串联主链，解决「短路断链」问题：
 * 原主链任一测试失败即中断后续，CI/本地拿不到完整失败清单，且定位困难。
 *
 * 行为约定：
 *  - 串行 spawn 全部套件，stdio 实时继承（不缓冲、不丢中间输出）
 *  - 不短路：前项失败仍继续跑后续，最终汇聚完整 PASS/FAIL 清单
 *  - fail-closed：任一失败 → 进程 exit 1；全过 → exit 0
 *
 * 新增单测须在此 SUITES 登记（顺序无关，测试相互独立）。
 * 清单等价原 package.json `npm test` 主链（run-all-tests + 30 个单测）。
 */
import { spawn } from "node:child_process";

/**
 * @type {[string, ...string[]][]}
 * 每项：[命令, ...参数]。等价原 npm test 主链，不自短路。
 */
const SUITES = [
  ["node", "tests/run-all-tests.mjs"],
  ["node", "--experimental-strip-types", "tests/unit/conversation-state-test.mjs"],
  ["node", "--experimental-strip-types", "tests/unit/patient-profile-test.mjs"],
  ["node", "--experimental-strip-types", "tests/unit/clarification-loop-test.mjs"],
  ["node", "tests/unit/grounding-rule-test.mjs"],
  ["node", "tests/unit/llm-judge-test.mjs"],
  ["node", "tests/unit/kg-graph-test.mjs"],
  ["node", "tests/unit/retrieval-router-test.mjs"],
  ["node", "tests/unit/retrieval-fts-test.mjs"],
  ["node", "tests/unit/faithfulness-guard-test.mjs"],
  ["node", "tests/unit/conflict-detector-test.mjs"],
  ["node", "tests/unit/rag-search-version-hint-test.mjs"],
  ["node", "tests/unit/scope-guard-test.mjs"],
  ["node", "tests/unit/query-sanitize-test.mjs"],
  ["node", "tests/unit/eval-gate-test.mjs"],
  ["node", "tests/unit/audit-logger-test.mjs"],
  ["node", "tests/unit/engine-version-test.mjs"],
  ["node", "tests/unit/observability-test.mjs"],
  ["node", "tests/unit/diagnostic-log-test.mjs"],
  ["node", "tests/unit/provider-health-test.mjs"],
  ["node", "tests/unit/alert-log-test.mjs"],
  ["node", "tests/unit/multisource/quality-gate-test.mjs"],
  ["node", "tests/unit/multisource/normalize-test.mjs"],
  ["node", "tests/unit/merge-into-gold-test.mjs"],
  ["node", "tests/unit/guard-replacement-test.mjs"],
  ["node", "--experimental-strip-types", "tests/unit/patient-forget-test.mjs"],
  ["node", "tests/unit/chunk-quality-test.mjs"],
  ["node", "tests/unit/chinese-heading-test.mjs"],
  ["node", "tests/unit/ab-prompt-eval-test.mjs"],
  ["node", "tests/unit/generate-ab-input-test.mjs"],
  ["node", "tests/unit/content-need-alignment-test.mjs"],
  ["node", "--test", "tests/unit/api-server-test.mjs"],
  ["node", "--test", "tests/unit/session-pool-test.mjs"],
  ["node", "tests/unit/retrieval-cache-test.mjs"],
];

function run(name, cmd, args) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, { stdio: ["ignore", "inherit", "inherit"] });
    proc.on("close", (code) => resolve(code ?? 1));
    proc.on("error", () => resolve(1));
  });
}

async function main() {
  console.log("=".repeat(60));
  console.log(`  聚合测试运行器 — 共 ${SUITES.length} 个套件（全跑不短路）`);
  console.log("=".repeat(60));

  const results = [];
  let idx = 0;
  for (const [cmd, ...args] of SUITES) {
    idx += 1;
    const name = args[args.length - 1];
    process.stdout.write(`\n▶ [${idx}/${SUITES.length}] ${name}\n`);
    const t0 = Date.now();
    const code = await run(name, cmd, args);
    const ms = Date.now() - t0;
    results.push({ name, code, ms });
    const tag = code === 0 ? "✅ PASS" : "❌ FAIL";
    process.stdout.write(`  ${tag} (${ms}ms, exit ${code})\n`);
  }

  const failed = results.filter((r) => r.code !== 0);
  console.log("\n" + "=".repeat(60));
  console.log(`汇总: ${results.length - failed.length}/${results.length} 通过, ${failed.length} 失败`);
  if (failed.length) {
    console.log("失败项:");
    for (const r of failed) console.log(`  - ${r.name} (exit ${r.code})`);
  }
  console.log("=".repeat(60));

  process.exit(failed.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("聚合测试运行异常:", err);
  process.exit(1);
});
