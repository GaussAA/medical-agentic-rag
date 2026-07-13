// scripts/ops/clarification-real-link.mjs
// B0-b · 真实 LLM 多轮澄清空转复现（07-13「脑溢血和心梗」）
//
// 与确定性护栏 tests/unit/clarification-loop-test.mjs 互补：
//   确定性护栏复现「agent 始终倾向澄清」的失败模式并断言代码层硬卡；
//   本件在【真实 LLM 运行期】驱动完整 pi Agent，验证 B1 硬上限在真 LLM 层亦生效
//   ——即令真 LLM 试图第 4 轮反问（07-13 真实空转），clarificationCount 仍 ≤ 3。
//
// 归属（与 scripts/ops/smoke-real-link.mjs 一致）：本地开发机 / 自托管 nightly runner。
//   本环境若 provider 降级（无外联），网关 exit 2 优雅跳过，不阻塞。
//
// 退出码：0=通过（真链路澄清硬上限生效）｜1=故障（计数越界/驱动异常）｜2=跳过（无外联）
// 运行：node scripts/ops/clarification-real-link.mjs [--json]

import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canRunRealLink, runScenario } from "./lib/agent-driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FORCE_JSON = process.argv.includes("--json");

const SCENARIO = {
  name: "07-13 空转复现（脑溢血和心梗）",
  turns: [
    "脑溢血和心梗怎么治？",
    "都要了解",
    "都不清楚，你直接说",
    "你别问了直接给方案", // 07-13 失败模式：仍想澄清
    "……",
  ],
};

async function main() {
  console.log("\n=== B0-b 真实 LLM 多轮澄清复现（07-13）===");
  const gate = await canRunRealLink();
  if (!gate.ok) {
    const msg = `跳过（无外联/provider 降级）：${gate.reason}`;
    console.log("  ⚠️ " + msg);
    const report = { status: "skip", reason: gate.reason, scenario: SCENARIO.name };
    if (FORCE_JSON) console.log(JSON.stringify(report, null, 2));
    return { code: 2, report };
  }

  // 全新会话：清全局澄清计数，避免跨场景累计
  const stPath = join(ROOT, ".pi", "conversation-state.json");
  try { if (existsSync(stPath)) rmSync(stPath); } catch {}

  const { turns, finalCount } = await runScenario(SCENARIO.turns, gate);
  const passed = finalCount <= 3; // B1 硬上限在真 LLM 层生效
  const report = {
    status: passed ? "pass" : "fail",
    scenario: SCENARIO.name,
    finalClarificationCount: finalCount,
    capHeld: passed,
    trace: turns,
  };
  for (const t of turns) {
    console.log(`  轮${t.idx} clarificationCount=${t.count}${t.timedOut ? " (超时)" : ""}`);
  }
  console.log(`  末轮澄清计数=${finalCount} → ${passed ? "✓ 硬上限生效（≤3）" : "✗ 越界（B1 修复失效！）"}`);
  if (FORCE_JSON) console.log(JSON.stringify(report, null, 2));
  try {
    mkdirSync(join(ROOT, "tests", "reports"), { recursive: true });
    writeFileSync(
      join(ROOT, "tests", "reports", "clarification-real-link.json"),
      JSON.stringify(report, null, 2),
    );
  } catch {}
  return { code: passed ? 0 : 1, report };
}

main()
  .then(({ code, report }) => {
    console.log(`\n结果：${report.status}（exit ${code}）`);
    process.exit(code);
  })
  .catch((e) => {
    console.error("\n[真实链路澄清] 未预期异常:", e?.stack || e);
    process.exit(1);
  });
