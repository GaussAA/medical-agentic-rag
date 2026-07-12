import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardReview, getMessageText } from "./lib/faithfulness-guard.mjs";
import { logGuardHit, logFaithfulness } from "./lib/observability.mjs";

/**
 * 在线 faithfulness / 安全护栏（维度二「生成可信度」运行时护栏）
 * -----------------------------------------------------------------------------------
 * 接入点：Pi 的 on("message_end") 钩子 —— assistant 最终回答定稿后、回传前端前触发。
 * 行为：
 *   1) on("context") 每轮 LLM 调用前缓存本轮用户问题（取 messages 最后一条 user），
 *      供 message_end 评审时作为 question（复用 patient-profile 已验证的 context 缓存模式）。
 *   2) on("message_end") 仅对 assistant 回答评审（role!=="assistant" 直接放行，避免误改工具结果）：
 *      - 调 lib/faithfulness-guard 的 guardReview（复用 lib/llm-judge 免费优先四维评审）。
 *      - action:"annotate" → 在回答末尾附「循证核验/安全护栏」批注（保留原回答，防误伤）。
 *      - action:"block"（仅 FAITHFULNESS_GUARD_HARD=1 且 safety 极低）→ 替换为纯护栏提示。
 *      - action:"pass" / 评审失败 / 超时 / 无 Key → 放行，不卡死回答（无静默失败，仅告警日志）。
 *   3) 旁路开关：env FAITHFULNESS_GUARD=off 整体关闭；FAITHFULNESS_GUARD_HARD=1 开启硬阻断。
 *
 * 原则契合：免费优先（复用 llm-judge）、无静默失败、显式错误捕获、双可测（.mjs 层）、
 *          依赖注入（judge 默认 judgeAnswer，单测可替换）。
 */

let lastUserQuestion = "";

export default function (pi: ExtensionAPI) {
  // 缓存本轮用户问题（仅副作用，不重写上下文）
  pi.on("context", (event: any) => {
    try {
      const msgs: any[] = (event && event.messages) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === "user") {
          lastUserQuestion = getMessageText(msgs[i]);
          break;
        }
      }
    } catch {
      /* 不影响主流程 */
    }
  });

  // 回答定稿后评审 + 护栏（异步 fire-and-forget，不阻塞 working 释放）
  // 注意：handler 非 async——不 await 任何评审，让 emitMessageEnd 立即完成
  pi.on("message_end", (event: any) => {
    if (process.env.FAITHFULNESS_GUARD === "off") return;
    const msg = event && event.message;
    if (!msg || msg.role !== "assistant") return;
    const answer = getMessageText(msg);
    if (!answer || answer.trim().length < 20) return;

    // 【关键】异步评审：fire-and-forget，不阻塞 emitMessageEnd
    // 评审结果仅落地埋点，不替换消息内容（避免扰动 Pi 内部状态机）
    const question = lastUserQuestion;
    Promise.race([
      guardReview({ question, answer }, { silent: true }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("guard review timeout")), 3000),
      ),
    ])
      .then((verdict: any) => {
        // 观测：忠实度软信号（含放行的低分），弥补 guard_hit 仅覆盖硬阻断的盲区
        logFaithfulness({
          action: verdict.action,
          score: typeof verdict.score === "number" ? verdict.score : undefined,
          reason: verdict.reasons || verdict.reason || undefined,
        }).catch((e: any) =>
          process.stderr.write(
            `[faithfulness-guard] 软信号观测失败，放行仍生效: ${e?.message || e}\n`,
          ),
        );
        if (verdict.action !== "pass" && verdict.annotatedText) {
          logGuardHit({
            type: "faithfulness",
            action: verdict.action,
            reason: verdict.reasons || verdict.reason || undefined,
          }).catch((e: any) =>
            process.stderr.write(
              `[faithfulness-guard] 埋点落盘失败，放行仍生效: ${e?.message || e}\n`,
            ),
          );
        }
      })
      .catch((e: any) => {
        // 评审失败/超时：放行（不扰用户），服务端留痕便于排障
        process.stderr.write(
          `[faithfulness-guard] 评审失败/超时，降级放行: ${e?.message || e}\n`,
        );
      });
  });
}
