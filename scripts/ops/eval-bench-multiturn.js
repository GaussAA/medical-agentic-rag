// scripts/ops/eval-bench-multiturn.js
// B3 · 多轮评测 harness（真实 LLM 运行期）
//
// 复 B0-b 真链路多轮驱动，扩为多场景评测：每个场景均验证
//   「澄清硬上限在真 LLM 层生效」(clarificationCount ≤ 3) —— 即 B1 修复
//   在真实 agent 运行期闭环，而非仅确定性单测层。
//
// 场景选取（覆盖 07-13 空转同类 + 多义/对比类）：
//   ① 07-13 空转（脑溢血和心梗）—— 多义双病、agent 倾向空转
//   ② 儿童支原体肺炎用药 —— 年版歧义（2023 vs 2025）
//   ③ 肝癌靶向 vs 胰腺癌对比 —— 多指南综合
//   ④ 糖尿病合并 CKD 用药 —— 剂量/人群敏感
//
// 与 scripts/ops/clarification-real-link.mjs 共用 lib/agent-driver.mjs 内核。
// 归属（与 smoke-real-link 一致）：本地开发机 / 自托管 nightly runner。
//   本环境若 provider 降级（无外联），网关 exit 2 优雅跳过，不阻塞。
//
// 退出码：0=全部通过｜1=某场景澄清越界（B1 修复失效）｜2=跳过（无外联）
// 运行：node scripts/ops/eval-bench-multiturn.js [--json]

import { rmSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { canRunRealLink, runScenario } from "./lib/agent-driver.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const FORCE_JSON = process.argv.includes("--json");

const SCENARIOS = [
  {
    name: "07-13 空转复现（脑溢血和心梗）",
    turns: [
      "脑溢血和心梗怎么治？",
      "都要了解",
      "都不清楚，你直接说",
      "你别问了直接给方案", // 07-13 失败模式：仍想澄清
      "……",
    ],
  },
  {
    name: "儿童支原体肺炎用药（年版歧义）",
    turns: [
      "儿童支原体肺炎用什么药？",
      "小孩 5 岁",
      "之前吃过阿奇霉素", // 未指定年版 → 仍可能澄清
      "你就按最新指南说", // 收敛 → 不应继续到 4 轮
    ],
  },
  {
    name: "肝癌靶向 vs 胰腺癌对比（多指南）",
    turns: [
      "肝癌靶向药和胰腺癌化疗方案有什么区别？",
      "想了解晚期的情况",
      "患者基因检测还没做",
      "先讲通用的",
    ],
  },
  {
    name: "糖尿病合并 CKD 用药（剂量敏感）",
    turns: [
      "2 型糖尿病合并 CKD3 期怎么选药？",
      "患者 65 岁",
      "肾功能 eGFR 45",
      "有没有心肾保护的",
    ],
  },
];

async function main() {
  console.log("\n=== B3 多轮评测 harness（真实 LLM）===");
  const gate = await canRunRealLink();
  if (!gate.ok) {
    const report = {
      generatedAt: new Date().toISOString(),
      status: "skip",
      reason: gate.reason,
      message: "本环境无外联（provider 降级），多轮真实评测优雅跳过。",
    };
    if (FORCE_JSON) console.log(JSON.stringify(report, null, 2));
    return { code: 2, report };
  }

  const results = [];
  let allPass = true;
  for (const sc of SCENARIOS) {
    // 全新会话：清全局澄清计数
    const stPath = join(ROOT, ".pi", "conversation-state.json");
    try { if (existsSync(stPath)) rmSync(stPath); } catch {}
    let scenarioResult;
    try {
      scenarioResult = await runScenario(sc.turns, gate);
    } catch (e) {
      scenarioResult = { error: String((e && e.message) || e), turns: [], finalCount: -1 };
    }
    const finalCount = scenarioResult.finalCount;
    const capHeld = typeof finalCount === "number" && finalCount <= 3;
    if (!capHeld) allPass = false;
    results.push({
      scenario: sc.name,
      turns: scenarioResult.turns || [],
      finalClarificationCount: finalCount,
      capHeld,
      error: scenarioResult.error,
    });
    console.log(
      `  [${capHeld ? "✓" : "✗"}] ${sc.name} → 末轮澄清=${finalCount} ${capHeld ? "(≤3 硬上限生效)" : "(越界！B1 失效)"}`,
    );
  }

  const report = {
    generatedAt: new Date().toISOString(),
    gate: { provider: gate.provider, model: gate.model },
    scenarioCount: SCENARIOS.length,
    allPass,
    results,
  };
  try {
    mkdirSync(join(ROOT, "tests", "reports"), { recursive: true });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(ROOT, "tests", "reports", "eval-multiturn.json"), JSON.stringify(report, null, 2)),
    );
    console.log("\n报告已写: tests/reports/eval-multiturn.json");
  } catch (e) {
    console.error("报告写盘失败（非致命）:", e?.message || e);
  }
  return { code: allPass ? 0 : 1, report };
}

main()
  .then(({ code, report }) => {
    const label = code === 2 ? "跳过（无外联/降级）" : code === 0 ? "全部通过" : "存在越界";
    console.log(`\n结果: ${label}（exit ${code}）`);
    if (FORCE_JSON) console.log(JSON.stringify(report, null, 2));
    process.exit(code);
  })
  .catch((e) => {
    console.error("\n[B3 多轮评测] 未预期异常:", e?.stack || e);
    process.exit(1);
  });
