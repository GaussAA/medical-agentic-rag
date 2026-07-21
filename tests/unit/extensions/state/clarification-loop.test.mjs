// clarification-loop-test.mjs
// B0-b · 多轮澄清空转回归护栏（确定性、零 LLM、可进 CI）。
//
// 背景（07-13 空转根因）：原对话状态机 clarificationCount 上限是全代码路径
// 从未自增的「死代码」——prompt 仅靠软提示「不超过 3 轮」约束 LLM，LLM 行为
// 失败（如「脑溢血和心梗怎么治」反复追问不收敛）时软约束完全失效，澄清循环
// 可无限空转。B1 将上限升为「代码层硬强制」（ask_clarification 工具达 3 轮即拒绝）。
//
// 本 harness 复现该失败模式（agent 始终倾向澄清、即便用户已明示停止），断言：
//   - 第 1/2/3 轮正常累计至 3；
//   - 第 4 轮（07-13 空转触发点）被工具硬卡，clarificationCount 恒为 3、返回「已达上限」；
//   - 第 5 轮仍试 → 依旧被卡（幂等，循环可证终止）。
// 另含一段「OLD 死代码对照」参考模拟（非被测代码），直观呈现无上限时循环如何空转，
// 以说明 B1 修复的必要性。
//
// 真 LLM 多轮（驱动完整 pi 运行期 + provider-proxy + 真 KB）属 nightly / 本地开发机
// 任务（与 scripts/ci/smoke/smoke-real-link.mjs 同一归属），本确定性护栏是其 CI 门禁。
//
// 运行: node --experimental-strip-types tests/unit/clarification-loop-test.mjs

import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

const sandbox = mkdtempSync(join(tmpdir(), "clarify-loop-"));
chdir(sandbox); // .pi/ 落盘副作用全部隔离到临时沙箱

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
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name); console.error("  ✗", name); }
}

const stPath = join(sandbox, ".pi", "conversation-state.json");
function readCount() {
  return JSON.parse(readFileSync(stPath, "utf-8")).clarificationCount;
}

// ============================================================
// 场景：07-13「脑溢血和心梗怎么治」空转复现
// agent 决策策略（失败模式）：只要用户未给足收敛信息，就继续澄清；
// 即令用户第 4 轮明示「别问了」，agent 仍试图第 4 次澄清（07-13 真实空转）。
// ============================================================
console.log("\n=== B0-b 多轮澄清空转回归（07-13 复现）===");

const questions = [
  "您指的是脑出血（脑溢血）还是心肌梗死（心梗）？请明确。",
  "请说明是急性期还是恢复期？",
  "请提供患者基础情况（年龄 / 既往史）以便收敛。",
];

// 前置：清空计数，模拟一个全新会话
await registered["reset_clarification_count"].execute("reset");
ok(readCount() === 0, "会话初始化：clarificationCount=0");

const trace = [];
await registered["reset_clarification_count"].execute("reset");
for (let i = 0; i < 5; i++) {
  const r = await registered["ask_clarification"].execute("k" + i, {
    question: i < 3 ? questions[i] : "（第 " + (i + 1) + " 次，仍想澄清）",
  });
  const text = r.content[0].text;
  trace.push({ turn: i + 1, count: readCount(), blocked: text.includes("已达上限") });
}

// 断言 1-3：前 3 轮正常累计
ok(trace[0].count === 1 && !trace[0].blocked, "第 1 轮：累计→1，未拦截");
ok(trace[1].count === 2 && !trace[1].blocked, "第 2 轮：累计→2，未拦截");
ok(trace[2].count === 3 && !trace[2].blocked, "第 3 轮：累计→3，达上限（未拦截，正常末轮）");

// 断言 4（核心护栏）：第 4 轮即 07-13 空转触发点——必须被硬卡
ok(trace[3].count === 3, "第 4 轮：clarificationCount 仍为 3（未增至 4），空转被代码层硬卡");
ok(trace[3].blocked, "第 4 轮：工具返回「已达上限」强制停止（07-13 根因闭环）");

// 断言 5：幂等——后续再试依旧被卡，循环可证终止
ok(trace[4].count === 3 && trace[4].blocked, "第 5 轮：依旧被卡（幂等，循环终止可证）");

// 断言 6：整体不变量——任何多轮序列后计数必 ≤ 3
ok(trace.every((t) => t.count <= 3), "不变量：任意多轮后 clarificationCount ≤ 3（循环不会无限空转）");

// ============================================================
// 对照：OLD 死代码行为模拟（非被测代码，仅说明修复必要性）
// 若 ask_clarification 无代码层上限（仅 soft prompt 约束），LLM 行为失败时
// 计数会一路自增、无终止——这正是 07-13 空转的数字画像。
// ============================================================
console.log("\n=== 对照：OLD 死代码（无硬上限）模拟 ===");
let oldCount = 0;
const OLD_CEIL = Infinity; // 原 clarificationCount 全路径无自增、亦无读取拦截
for (let i = 0; i < 7; i++) {
  // 模拟 LLM 持续澄清、软提示被忽略
  oldCount += 1; // 原代码：无自增点也无拦截点 → 计数要么恒 0 要么失控增长
  if (oldCount > OLD_CEIL) break;
}
ok(oldCount === 7, "OLD 模拟：无硬上限时澄清轮次失控增长（7 轮未止）——印证 B1 修复价值");
console.log("  · 说明：OLD 计数若走原死代码路径则恒为 0（上限形同虚设），若 LLM 自行累加则无限——二者皆空转。B1 以代码层硬卡根治。");

// ============================================================
console.log("\n多轮澄清护栏单测: " + pass + " 通过 / " + fail + " 失败");
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
