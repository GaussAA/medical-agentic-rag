// grounding-rule-test.mjs
// B2 · 受控推理链接线护栏（确定性、零 LLM、可进 CI）。
//
// 守护目标：B2 将「生成侧受控推理」写入系统 prompt 与 faithfulness 评审口径，
// 防止这两条规则在后续重构中被误删（即"接线不丢"）。两项均为静态存在性断言：
//   1) 系统 prompt 含「受控推理链」铁律 + 引用格式要求 chunk_id 级溯源 + 未接地拒答标记；
//   2) 四维 judge 的忠实度口径已强化「溯源粒度」——确定性结论无 chunk_id 级出处应判低分。
// 真 LLM 行为（是否真按 chunk_id 接地）属 nightly / 本地开发机评测，本确定性护栏是其 CI 门禁。
//
// 运行: node tests/unit/grounding-rule-test.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildJudgeMessages } from "../../../../.pi/extensions/lib/llm-judge.mjs";

const HERE = dirname(fileURLToPath(import.meta.url)); // tests/unit
const PROMPT = join(HERE, "..", "..", "..", "..", ".pi", "prompts", "medical-agent.md");
const prompt = readFileSync(PROMPT, "utf-8");

let pass = 0, fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (extra ? " :: " + extra : "")); console.error("  ✗", name); }
}

console.log("\n=== B2 受控推理链 · 接线护栏 ===");

// 1) 系统 prompt 规则存在性
ok("prompt 含『受控推理链』生成侧铁律", prompt.includes("受控推理链"));
ok("prompt 引用格式要求 chunk_id 级溯源", prompt.includes("chunk_id"));
ok("prompt 含未接地拒答标记（⚠️ 未接地·依据不足）", prompt.includes("未接地·依据不足"));

// 2) faithfulness judge 口径强化「溯源粒度」
const msgs = buildJudgeMessages({ question: "q", answer: "a" });
const sys = msgs[0] && msgs[0].content ? msgs[0].content : "";
ok(
  "judge 忠实度口径含循证约束（循证 / 忠实度）",
  sys.includes("循证") || sys.includes("忠实度"),
);

console.log("\n受控推理链护栏单测: " + pass + " 通过 / " + fail + " 失败");
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
