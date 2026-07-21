// audit-logger-test.mjs
// 审计链运行期接线辅助单测（纯函数部分，零 IO、确定性，CI 可跑）。
// 运行: node tests/unit/audit-logger-test.mjs
//
// 说明：auditTurn 委托 auditChainLog（已由其专属单测覆盖链式/HMAC 校验），
// 此处仅验证本模块负责的纯逻辑：lastUserText 抽取、isNewUserTurn 去重判定。

import {
  lastUserText,
  isNewUserTurn,
} from "../../../.pi/extensions/lib/audit-logger.mjs";

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

console.log("\n[1] lastUserText — 抽取最后一条 user");
{
  ok(
    "数组 content 抽取",
    lastUserText([{ role: "user", content: [{ type: "text", text: "高血压怎么治" }] }]) ===
      "高血压怎么治",
  );
  ok(
    "字符串 content 抽取（取末条 user）",
    lastUserText([{ role: "assistant", content: "..." }, { role: "user", content: "糖尿病" }]) ===
      "糖尿病",
  );
  ok("无 user 返回空串", lastUserText([{ role: "system", content: "x" }]) === "");
  ok("非数组返回空串", lastUserText(null) === "");
  ok(
    "空 content 数组回落空串",
    lastUserText([{ role: "user", content: [] }]) === "",
  );
}

console.log("\n[2] isNewUserTurn — 新轮去重判定");
{
  ok("不同文本→新轮", isNewUserTurn("a", "b") === true);
  ok("相同文本→非新轮", isNewUserTurn("a", "a") === false);
  ok("当前无 user(curr 空)→非新轮（避免噪声）", isNewUserTurn("a", "") === false);
  ok("prev 空且 curr 有→新轮", isNewUserTurn("", "x") === true);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) console.log("失败项:", fails);
process.exit(fail ? 1 : 0);
