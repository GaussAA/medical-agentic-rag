// .pi/extensions/lib/faithfulness-guard.mjs
//
// 在线 faithfulness / 安全护栏评审层（维度二「生成可信度」的运行时护栏）。
// 由 safety.faithfulness-guard.ts 在 on("message_end") 钩子里调用，对 assistant 最终回答
// 做四维评审（复用 lib/llm-judge 免费优先），命中低分则附批注 / 硬阻断。
//
// 设计纪律（契合项目原则）：
//   · 免费优先：judge 默认复用 lib/llm-judge（sensenova 免费池 → deepseek 兜底），不自写端点。
//   · 无静默失败：LLM 不可用 / 超时 / 抛错 → 一律放行（action:"pass"）+ 结构化日志，绝不卡死回答。
//   · 双可测：纯 .mjs；judge 依赖注入（默认 judgeAnswer），单测可传假 judge 走纯逻辑、零真 LLM 调用。
//   · 控本：shouldGuard 启发式（长度/临床关键词）仅在「高风险回答」才评审，避免每句都烧免费额度。
//   · 保守护栏：默认仅附批注（不删原回答，防误伤）；仅 HARD 开关 + 安全极低才阻断。

import { judgeAnswer, isLLMAvailable } from "./llm-judge.mjs";

// ---- 阈值（可调，集中管理）----
const FAITH_THRESHOLD = 0.6; // 忠实度低于此 → 附「循证核验」批注
const SAFETY_THRESHOLD = 0.5; // 安全低于此 → 附「安全护栏」批注
const SAFETY_HARD_THRESHOLD = 0.4; // 安全低于此且 HARD 开启 → 硬阻断
const GUARD_TIMEOUT_MS = 8000; // 评审整体超时（避免拖慢回答回传）

const CLINICAL_HINTS = [
  "治疗", "用药", "剂量", "诊断", "推荐", "建议", "应服", "禁忌",
  "指征", "方案", "一线", "首选", "预后", "随访", "复查", "手术",
  "化疗", "放疗", "靶向前", "免疫", "抗凝", "降压", "降糖", "抗菌",
];

/**
 * 启发式：是否值得消耗免费 LLM 额度做评审（控本）。
 * 优先级：含临床关键词 → 必审（高风险，无视长度）；否则长文本(>200)兜底；其余放行。
 * @param {string} answer  待评审回答文本
 * @returns {boolean} true 表示需要评审
 */
export function shouldGuard(answer) {
  if (typeof answer !== "string" || answer.trim().length === 0) return false;
  if (CLINICAL_HINTS.some((k) => answer.includes(k))) return true;
  if (answer.length > 200) return true;
  return false;
}

/**
 * 从 AgentMessage.content（[{type,text}] | string）抽取纯文本。
 * @param {{content?:string|Array<{type:string,text?:string}>}} msg  Pi Agent 消息对象
 * @returns {string} 纯文本内容
 */
export function getMessageText(msg) {
  if (!msg) return "";
  const c = msg.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) {
    return c
      .map((p) => (p && p.type === "text" ? p.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function withTimeout(promise, ms) {
  return new Promise((resolve) => {
    const t = setTimeout(() => resolve({ __timeout: true }), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        resolve({ __error: String((e && e.message) || e) });
      },
    );
  });
}

function buildAnnotations(dims, reasons) {
  const parts = [];
  if (dims.faithfulness < FAITH_THRESHOLD) {
    parts.push(
      `⚠️ 循证核验：自动评审「忠实度」得分偏低（${dims.faithfulness}）。部分表述可能缺乏直接循证依据，请结合临床判断并核实原始指南。` +
        (reasons ? ` 评审备注：${reasons}` : ""),
    );
  }
  if (dims.safety < SAFETY_THRESHOLD) {
    parts.push(
      `⚠️ 安全护栏：自动评审「安全」得分偏低（${dims.safety}）。涉及紧急症候请及时就医，本工具不下诊断、不替代医师。` +
        (reasons ? ` 评审备注：${reasons}` : ""),
    );
  }
  return parts;
}

function buildAnnotated(answer, parts) {
  return (
    answer +
    "\n\n---\n" +
    parts.join("\n") +
    "\n（以上提示由自动循证质量评审生成，本工具为循证信息辅助，不替代医师诊断。）"
  );
}

function buildBlocked(dims, reasons) {
  return (
    "⚠️ 安全护栏触发：本回答在自动评审中「安全」维度得分过低（" +
    dims.safety +
    "），存在潜在风险，已拦截原回答。\n涉及健康问题请及时就医，本工具不替代医师诊断与诊疗决策。" +
    (reasons ? "\n评审备注：" + reasons : "")
  );
}

/**
 * 在线护栏评审。
 * @param {object} args { question, answer, judge=judgeAnswer, isAvailable=isLLMAvailable }
 *   - judge: 四维评审函数（默认 lib/llm-judge.judgeAnswer），注入便于单测零真 LLM 调用。
 *   - isAvailable: LLM 可用性探测（默认 isLLMAvailable），注入便于 CI（无 Key）下确定性验证逻辑。
 * @returns {Promise<{action:'pass'|'annotate'|'block', dims?, reasons?, annotatedText?, reason?, skipped?}>}
 */
export async function guardReview({ question, answer, judge = judgeAnswer, isAvailable = isLLMAvailable }, { silent = false } = {}) {
  if (process.env.FAITHFULNESS_GUARD === "off") {
    return { action: "pass", reason: "disabled" };
  }
  if (!shouldGuard(answer)) {
    return { action: "pass", reason: "low_risk_skip" };
  }
  if (!isAvailable()) {
    if (!silent) console.warn("[faithfulness-guard] LLM 不可用，放行（不评审）");
    return { action: "pass", skipped: true, reason: "no_llm" };
  }

  const res = await withTimeout(
    judge({ question: question || "", answer }),
    GUARD_TIMEOUT_MS,
  );

  if (res && res.__timeout) {
    if (!silent) console.warn("[faithfulness-guard] 评审超时，放行");
    return { action: "pass", skipped: true, reason: "timeout" };
  }
  if (res && res.__error) {
    if (!silent) console.warn("[faithfulness-guard] 评审异常，放行:", res.__error);
    return { action: "pass", skipped: true, reason: "error:" + res.__error };
  }
  if (res && res.skipped) {
    if (!silent) console.warn("[faithfulness-guard] judge 跳过（" + res.reason + "），放行");
    return { action: "pass", skipped: true, reason: res.reason };
  }

  const dims = {
    faithfulness: Number(res.faithfulness),
    answerRelevance: Number(res.answerRelevance),
    clinicalCorrectness: Number(res.clinicalCorrectness),
    safety: Number(res.safety),
  };
  const parts = buildAnnotations(dims, res.reasons);

  if (parts.length === 0) {
    return { action: "pass", dims, reasons: res.reasons };
  }

  const hard = process.env.FAITHFULNESS_GUARD_HARD === "1";
  if (hard && dims.safety < SAFETY_HARD_THRESHOLD) {
    return {
      action: "block",
      dims,
      reasons: res.reasons,
      annotatedText: buildBlocked(dims, res.reasons),
    };
  }

  return {
    action: "annotate",
    dims,
    reasons: res.reasons,
    annotatedText: buildAnnotated(answer, parts),
  };
}
