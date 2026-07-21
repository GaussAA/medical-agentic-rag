// llm-judge-test.mjs
// P1#9 专用单测 —— 四维 Judge 纯函数（buildJudgeMessages 输出形态 + 可用性判定）。
//
// grounding-rule-test.mjs 已间接覆盖 buildJudgeMessages 的存在性；
// 本测试显式断言输出形态与四维完整度，并确定性验证 isLLMAvailable / availableKeyCount。
// 运行: node tests/unit/llm-judge-test.mjs

// 必须在 import 前注入凭证，使 loadEnv() 短路、SENSENOVA_KEYS 被填充（确定性）。
process.env.SENSENOVA_API_KEYS = "test-k1,test-k2";
process.env.DEEPSEEK_API_KEY = "test-deepseek";

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // tests/unit
const MOD = pathToFileURL(
  join(HERE, "..", "..", "..", "..", ".pi", "extensions", "lib", "llm-judge.mjs"),
).href;
const { buildJudgeMessages, isLLMAvailable, availableKeyCount } = await import(MOD);

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; fails.push(name + (extra ? " :: " + extra : "")); console.error("  ✗", name, extra); }
}

console.log("\n=== P1#9 llm-judge · 四维 Judge 单测 ===\n");

// 1) buildJudgeMessages 形态与四维
const msgs = buildJudgeMessages({
  question: "二甲双胍孕期可用吗？",
  answer: "不推荐，改用胰岛素。",
  gtSources: ["妊娠期高血糖诊治指南"],
});
ok("返回 2 条消息", Array.isArray(msgs) && msgs.length === 2);
ok("第1条为 system", msgs[0] && msgs[0].role === "system");
ok("第2条为 user", msgs[1] && msgs[1].role === "user");
const sys = msgs[0].content || "";
ok("系统 prompt 含 faithfulness", sys.includes("faithfulness"));
ok("系统 prompt 含 answerRelevance", sys.includes("answerRelevance"));
ok("系统 prompt 含 clinicalCorrectness", sys.includes("clinicalCorrectness"));
ok("系统 prompt 含 safety", sys.includes("safety"));
ok(
  "忠实度口径含循证约束(循证/忠实度)",
  sys.includes("循证") || sys.includes("忠实度"),
);
const usr = msgs[1].content || "";
ok("user 含问题", usr.includes("二甲双胍孕期可用吗？"));
ok("user 含回答", usr.includes("不推荐，改用胰岛素。"));
ok("user 含应引指南", usr.includes("妊娠期高血糖诊治指南"));

// 2) 缺省参数安全（无 gtSources）
const m2 = buildJudgeMessages({ question: "q", answer: "a" });
ok("无 gtSources 不抛错且标越界", m2.length === 2 && (m2[1].content || "").includes("（无/越界）"));

// 3) 可用性判定（确定性：env 已注入免费 Key）
ok("isLLMAvailable() === true（env 注入免费 Key）", isLLMAvailable() === true);
ok("availableKeyCount() === 2", availableKeyCount() === 2);

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
