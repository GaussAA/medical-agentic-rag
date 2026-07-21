// faithfulness-guard-test.mjs
// 在线护栏评审层单测：依赖注入 mock judge，零真 LLM 调用，确定性验证逻辑分级。
// 运行: node tests/unit/faithfulness-guard-test.mjs

import { guardReview, shouldGuard, getMessageText } from "../../../../.pi/extensions/lib/faithfulness-guard.mjs";

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

// 注入：始终可用 + mock judge
const AVAIL = () => true;
const HIGH = async () => ({ skipped: false, faithfulness: 0.95, answerRelevance: 0.9, clinicalCorrectness: 0.92, safety: 0.98, reasons: "ok" });
const LOW_FAITH = async () => ({ skipped: false, faithfulness: 0.3, answerRelevance: 0.9, clinicalCorrectness: 0.9, safety: 0.95, reasons: "虚构嫌疑" });
const LOW_SAFE = async () => ({ skipped: false, faithfulness: 0.9, answerRelevance: 0.9, clinicalCorrectness: 0.9, safety: 0.3, reasons: "危险建议" });
const THROW = async () => { throw new Error("boom"); };
const TIMEOUT = async () => ({ __timeout: true });
const SKIP = async () => ({ skipped: true, reason: "no_api_key" });

const LONG_ANSWER = "对于2型糖尿病合并 CKD3 期患者，推荐优选 SGLT2 抑制剂（如达格列净）作为一线治疗，兼顾降糖与心肾保护；用药期间需监测肾功能与生殖泌尿道感染风险。";

// ─────────────────────────────────────────────
console.log("\n[0] shouldGuard 启发式控本");
{
  ok("过短文本不评审", shouldGuard("好的") === false);
  ok("短且无临床关键词不评审", shouldGuard("今天天气不错") === false);
  ok("长文本强制评审", shouldGuard("x".repeat(250)) === true);
  ok("短含临床关键词评审", shouldGuard("建议用药剂量") === true);
}

// ─────────────────────────────────────────────
console.log("\n[1] getMessageText 抽取");
{
  ok("数组形态抽取", getMessageText({ content: [{ type: "text", text: "回答内容" }] }) === "回答内容");
  ok("字符串形态原样返回", getMessageText({ content: "直接文本" }) === "直接文本");
  ok("空 message 返回空串", getMessageText(null) === "");
}

// ─────────────────────────────────────────────
console.log("\n[2] 旁路 / 低风险 / 可用性 —— 失败降级为未核验批注（无静默放行）");
{
  const prev = process.env.FAITHFULNESS_GUARD;
  process.env.FAITHFULNESS_GUARD = "off";
  const d = await guardReview({ question: "q", answer: LONG_ANSWER, judge: LOW_FAITH, isAvailable: AVAIL });
  ok("关闭开关 → pass(disabled)", d.action === "pass" && d.reason === "disabled", JSON.stringify(d));
  process.env.FAITHFULNESS_GUARD = prev;

  const skipLow = await guardReview({ question: "q", answer: "简短", judge: LOW_FAITH, isAvailable: AVAIL });
  ok("低风险短文本 → pass(low_risk_skip)", skipLow.action === "pass" && skipLow.reason === "low_risk_skip", JSON.stringify(skipLow));

  const noLlm = await guardReview({ question: "q", answer: LONG_ANSWER, judge: LOW_FAITH, isAvailable: () => false });
  ok("LLM 不可用 → annotate(未核验批注, fail-closed, 不抛)", noLlm.action === "annotate" && noLlm.skipped === true && noLlm.annotatedText.includes("未经自动循证核验"), JSON.stringify(noLlm));
}

// ─────────────────────────────────────────────
console.log("\n[3] judge 异常 / 超时 / 跳过 —— 降级为未核验批注（不卡死）");
{
  const t = await guardReview({ question: "q", answer: LONG_ANSWER, judge: THROW, isAvailable: AVAIL });
  ok("judge 抛错 → annotate(未核验批注, 不抛异常)", t.action === "annotate" && !!t.reason && t.annotatedText.includes("未经自动循证核验"), JSON.stringify(t));

  const to = await guardReview({ question: "q", answer: LONG_ANSWER, judge: TIMEOUT, isAvailable: AVAIL });
  ok("评审超时 → annotate(未核验批注, 不卡死)", to.action === "annotate" && to.skipped === true && to.annotatedText.includes("未经自动循证核验"), JSON.stringify(to));

  const sk = await guardReview({ question: "q", answer: LONG_ANSWER, judge: SKIP, isAvailable: AVAIL });
  ok("judge 跳过 → annotate(未核验批注)", sk.action === "annotate" && sk.skipped === true && sk.annotatedText.includes("未经自动循证核验"), JSON.stringify(sk));
}

// ─────────────────────────────────────────────
console.log("\n[4] 评审命中 —— 附批注 / 硬阻断");
{
  const hi = await guardReview({ question: "q", answer: LONG_ANSWER, judge: HIGH, isAvailable: AVAIL });
  ok("四维全高 → pass", hi.action === "pass", JSON.stringify(hi));

  const lf = await guardReview({ question: "q", answer: LONG_ANSWER, judge: LOW_FAITH, isAvailable: AVAIL });
  ok("忠实度低 → annotate", lf.action === "annotate", JSON.stringify(lf));
  ok("批注含『循证核验』", lf.annotatedText.includes("循证核验"), lf.annotatedText);
  ok("批注保留原回答", lf.annotatedText.includes("SGLT2 抑制剂"), lf.annotatedText);
  ok("批注含免责声明", lf.annotatedText.includes("不替代医师诊断"), lf.annotatedText);

  const ls = await guardReview({ question: "q", answer: LONG_ANSWER, judge: LOW_SAFE, isAvailable: AVAIL });
  ok("安全低且 HARD 默认开启 → block", ls.action === "block", JSON.stringify(ls));
  ok("阻断文本含『已拦截』", ls.annotatedText.includes("已拦截"), ls.annotatedText);
}

// ─────────────────────────────────────────────
console.log("\n[5] 硬阻断（默认开启 fail-closed；safety 极低 → block）");
{
  const prev = process.env.FAITHFULNESS_GUARD_HARD;
  // 默认（不设 / 非 "0"）→ HARD 开启
  delete process.env.FAITHFULNESS_GUARD_HARD;
  const blk = await guardReview({ question: "q", answer: LONG_ANSWER, judge: LOW_SAFE, isAvailable: AVAIL });
  ok("默认 HARD 开启 → safety 极低 block", blk.action === "block", JSON.stringify(blk));
  ok("阻断文本含『已拦截』", blk.annotatedText.includes("已拦截"), blk.annotatedText);

  // 显式关闭 → annotate 而非 block
  process.env.FAITHFULNESS_GUARD_HARD = "0";
  const ann = await guardReview({ question: "q", answer: LONG_ANSWER, judge: LOW_SAFE, isAvailable: AVAIL });
  ok("显式 HARD=0 → annotate（不阻断）", ann.action === "annotate", JSON.stringify(ann));
  process.env.FAITHFULNESS_GUARD_HARD = prev;
}

// ─────────────────────────────────────────────
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
process.exit(0);
