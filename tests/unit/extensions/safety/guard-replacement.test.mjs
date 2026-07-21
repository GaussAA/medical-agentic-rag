// guard-replacement-test.mjs
// E1 护栏真生效单测：验证 lib 层 buildReplacementMessage（faithfulness / conflict）
// 将评审 verdict / 冲突 res 正确转为 Pi message_end 的替换消息（{role:"assistant", content}），
// 或 pass / 无批注时返回 undefined（调用方据此放行）。
// 直导纯 .mjs，零 LLM 调用，确定性；运行: node tests/unit/guard-replacement-test.mjs

import { buildReplacementMessage as buildFaith } from "../../.pi/extensions/lib/faithfulness-guard.mjs";
import { buildReplacementMessage as buildConflict } from "../../.pi/extensions/lib/conflict-detector.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    fails.push(name + (extra ? " :: " + extra : ""));
    console.log("  ✗", name, extra);
  }
}

const ANN = "⚠️ 循证核验：自动评审「忠实度」得分偏低。\n（以上提示由自动循证质量评审生成，本工具为循证信息辅助，不替代医师诊断。）";
const BLOCK = "⚠️ 安全护栏触发：本回答在自动评审中「安全」维度得分过低，存在潜在风险，已拦截原回答。\n涉及健康问题请及时就医，本工具不替代医师诊断与诊疗决策。";
const CONFLICT_ANN = "⚠️ 跨指南提示：以下指南对该问题存在版本差异或意见分歧，请以主诊医师临床判断为准：\n- 版本差异：《动脉粥样硬化诊治指南》已标记为废止（现行版：《动脉粥样硬化诊治指南（2023更新版）》）";

const MSG_STR = { role: "assistant", content: "对于2型糖尿病合并CKD3期患者，推荐优选SGLT2抑制剂。" };
const MSG_ARR = { role: "assistant", content: [{ type: "text", text: "对于2型糖尿病合并CKD3期患者，推荐优选SGLT2抑制剂。" }] };

// ────────────────────────────────────────
console.log("\n[A] faithfulness buildReplacementMessage");
{
  // block 档 → 替换为纯拦截提示（role 不变）
  const r = buildFaith(MSG_STR, { action: "block", annotatedText: BLOCK });
  ok("block → 返回替换消息", r && typeof r === "object");
  ok("block → role 仍为 assistant", r && r.role === "assistant", JSON.stringify(r && r.role));
  ok("block → content 为拦截文", r && r.content === BLOCK);

  // annotate 档（string content）→ 原回答 + 批注
  const r2 = buildFaith(MSG_STR, { action: "annotate", annotatedText: ANN });
  ok("annotate(string) → 返回替换消息", r2 && r2.role === "assistant");
  ok("annotate(string) → 保留原回答", r2 && typeof r2.content === "string" && r2.content.includes("SGLT2抑制剂"));
  ok("annotate(string) → 末尾附加批注", r2 && r2.content.includes("循证核验"));

  // annotate 档（array content）→ 数组末尾追加批注块
  const r3 = buildFaith(MSG_ARR, { action: "annotate", annotatedText: ANN });
  ok("annotate(array) → role 仍为 assistant", r3 && r3.role === "assistant");
  ok("annotate(array) → content 为数组", r3 && Array.isArray(r3.content));
  ok("annotate(array) → 原块保留", r3 && r3.content.length === 2 && r3.content[0].text.includes("SGLT2抑制剂"));
  ok("annotate(array) → 末块为批注", r3 && r3.content[1].type === "text" && r3.content[1].text.includes("循证核验"));

  // pass → undefined（放行，不替换）
  ok("pass → undefined（放行）", buildFaith(MSG_STR, { action: "pass", annotatedText: ANN }) === undefined);
  // 无 verdict → undefined
  ok("verdict 缺失 → undefined", buildFaith(MSG_STR, null) === undefined);
  // annotate 但无批注文本 → undefined（防空替换）
  ok("annotate 无批注文本 → undefined", buildFaith(MSG_STR, { action: "annotate" }) === undefined);
}

// ────────────────────────────────────────
console.log("\n[B] conflict buildReplacementMessage");
{
  // annotate + annotation → 替换消息
  const r = buildConflict(MSG_STR, { action: "annotate", annotation: CONFLICT_ANN });
  ok("annotate → 返回替换消息", r && r.role === "assistant");
  ok("annotate → 保留原回答", r && typeof r.content === "string" && r.content.includes("SGLT2抑制剂"));
  ok("annotate → 末尾附加冲突批注", r && r.content.includes("跨指南提示") && r.content.includes("动脉粥样硬化"));

  // pass → undefined
  ok("pass → undefined（放行）", buildConflict(MSG_STR, { action: "pass", annotation: CONFLICT_ANN }) === undefined);
  // 无 res → undefined
  ok("res 缺失 → undefined", buildConflict(MSG_STR, null) === undefined);
  // annotate 无 annotation → undefined
  ok("annotate 无 annotation → undefined", buildConflict(MSG_STR, { action: "annotate" }) === undefined);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
process.exit(0);
