// conversation-state-test.mjs
// B0 验证优先 · 对话状态机确定性单测（零 LLM、可进 CI）。
// 直导 .pi/extensions/state.conversation-state.ts，mock pi 捕获 registerTool / on("context")，
// chdir 到临时沙箱，使 .pi/conversation-state.json 落盘副作用隔离。
// 运行: node --experimental-strip-types tests/unit/conversation-state-test.mjs

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

const sandbox = mkdtempSync(join(tmpdir(), "conv-state-"));
chdir(sandbox); // .pi/ 写入全部落到临时沙箱

const registered = {};
const hooks = {};
const mockPi = {
  registerTool: (spec) => { registered[spec.name] = spec; },
  on: (ev, fn) => { hooks[ev] = fn; },
};

const factory = (await import("../../../../.pi/extensions/state.conversation-state.ts")).default;
await factory(mockPi);

let pass = 0, fail = 0;
const fails = [];
const findings = [];
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name); console.error("  ✗", name); }
}
function finding(msg) { findings.push(msg); console.log("  ⚠️", msg); }

// 1. 槽位写入 + context 注入
await registered["update_conversation_state"].execute("t1", {
  chiefComplaint: "肝癌靶向药", bodyPart: "肝", population: "成人",
});
let ctx = await hooks["context"]({ messages: [] });
ok(Array.isArray(ctx.messages) && ctx.messages.length === 1, "context 注入 1 条");
ok(ctx.messages[0].content.includes("肝"), "槽位 bodyPart 注入");
ok(ctx.messages[0].content.includes("肝癌靶向药"), "槽位 chiefComplaint 注入");
ok(ctx.messages[0].content.includes("成人"), "槽位 population 注入");

// 2. askedQuestions 去重（同问两次 → 仅 1 条）
await registered["update_conversation_state"].execute("t2", { askedQuestion: "您指的是哪年版指南？" });
await registered["update_conversation_state"].execute("t3", { askedQuestion: "您指的是哪年版指南？" });
ctx = await hooks["context"]({ messages: [] });
const stPath = join(sandbox, ".pi", "conversation-state.json");
ok(existsSync(stPath), "状态文件已落盘");
const st = JSON.parse(readFileSync(stPath, "utf-8"));
ok(st.askedQuestions.length === 1, "askedQuestions 去重（实际 " + st.askedQuestions.length + " 条）");
ok(ctx.messages[0].content.includes("已问过的问题"), "askedQuestions 渲染");

// 3. yearVersion 仅显式设置、currentGuide 注入
await registered["update_conversation_state"].execute("t4", {
  yearVersion: 2026, currentGuide: "原发性肝癌诊疗指南（2026版）",
});
ctx = await hooks["context"]({ messages: [] });
ok(ctx.messages[0].content.includes("2026 版"), "yearVersion 渲染");
ok(ctx.messages[0].content.includes("原发性肝癌诊疗指南（2026版）"), "currentGuide 注入");

// 4. reset_clarification_count 归零
await registered["reset_clarification_count"].execute("r1");
const st2 = JSON.parse(readFileSync(stPath, "utf-8"));
ok(st2.clarificationCount === 0, "reset_clarification_count 归零");

// 5. ask_clarification 自增 + ≤3 上限强制（B1 硬化：原死代码已补）
const clarR1 = await registered["ask_clarification"].execute("k1", { question: "您指的是哪年版指南？" });
let st3 = JSON.parse(readFileSync(stPath, "utf-8"));
ok(st3.clarificationCount === 1, "ask_clarification 自增→1（实际 " + st3.clarificationCount + "）");
ok(clarR1.content[0].text.includes("第 1/3 轮"), "返回第 1/3 轮");
await registered["ask_clarification"].execute("k2", { question: "请问具体部位？" });
await registered["ask_clarification"].execute("k3", { question: "患者人群？" });
st3 = JSON.parse(readFileSync(stPath, "utf-8"));
ok(st3.clarificationCount === 3, "累计至 3（实际 " + st3.clarificationCount + "）");
const clarR4 = await registered["ask_clarification"].execute("k4", { question: "再问一次？" });
st3 = JSON.parse(readFileSync(stPath, "utf-8"));
ok(st3.clarificationCount === 3, "第 4 轮硬卡上限（仍为 3，实际 " + st3.clarificationCount + "）");
ok(clarR4.content[0].text.includes("已达上限"), "上限返回强制停止提示");

console.log("\n对话状态机单测: " + pass + " 通过 / " + fail + " 失败；发现 " + findings.length + " 项");
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
