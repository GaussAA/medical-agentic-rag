import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { guardReview, getMessageText, buildReplacementMessage } from "./lib/faithfulness-guard.mjs";
import { logGuardHit, logFaithfulness } from "./lib/observability.mjs";
// @ts-ignore —— 诊断统一出口，例程诊断落 logs/ 不污染终端
import { diag } from "./lib/diagnostic-log.mjs";
import { alert } from "./lib/alert-log.mjs";

/**
 * 在线 faithfulness / 安全护栏（维度二「生成可信度」运行时护栏）
 * -----------------------------------------------------------------------------------
 * 接入点：Pi 的 on("message_end") 钩子 —— assistant 最终回答定稿后、回传前端前触发。
 * 行为：
 *   1) on("context") 每轮 LLM 调用前缓存本轮用户问题（取 messages 最后一条 user），
 *      供 message_end 评审时作为 question（复用 patient-profile 已验证的 context 缓存模式）。
 *   2) on("message_end") 仅对 assistant 回答评审（role!=="assistant" 直接放行，避免误改工具结果）：
 *      - 调 lib/faithfulness-guard 的 guardReview（复用 lib/llm-judge 免费优先四维评审）。
 *      - action:"annotate" → 经 buildReplacementMessage 在回答末尾附「循证核验/安全护栏」批注
 *        （保留原回答，防误伤），return { message } 真替换。
 *      - action:"block"（仅 FAITHFULNESS_GUARD_HARD=1 且 safety 极低）→ 替换为纯护栏拦截提示，return { message } 真替换。
 *      - action:"pass" / 评审失败 → 降级放行（不卡死回答）；超时 / 无 Key → 降级为未核验批注（fail-closed），不再静默放行。
 *   3) 旁路开关：env FAITHFULNESS_GUARD=off 整体关闭；FAITHFULNESS_GUARD_HARD=1 开启硬阻断。
 *
 * 真生效机制：Pi 框架 await message_end 返回值并 _replaceMessageInPlace 同步 agent state / 会话持久化
 *   （见 pi/packages/coding-agent 的 emitMessageEnd），故 annotate/block 批注/拦截直接落到最终回答，
 *   而非仅埋点丢弃（旧版 fire-and-forget 导致评审结果永不生效，即 G1 根因）。
 *
 * 原则契合：免费优先（复用 llm-judge）、无静默失败、显式错误捕获、双可测（.mjs 层 / .ts 扩展层）、
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

  // 回答定稿后评审 + 护栏（async：Pi 框架 await message_end 返回值，
  // 经 _replaceMessageInPlace 同步 agent state / 会话持久化，annotate/block 真生效）
  pi.on("message_end", async (event: any) => {
    if (process.env.FAITHFULNESS_GUARD === "off") return;
    const msg = event && event.message;
    if (!msg || msg.role !== "assistant") return;
    const answer = getMessageText(msg);
    if (!answer || answer.trim().length < 20) return;

    const question = lastUserQuestion;
    let verdict: any;
    try {
      // 异步评审：await 结果，经 buildReplacementMessage 转为替换消息并 return
      verdict = await Promise.race([
        guardReview({ question, answer }, { silent: true }),
        // 须 > lib GUARD_TIMEOUT_MS(8000)，否则慢评审被本层静默丢弃（fail-open 隐患）
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("guard review timeout")), 9000),
        ),
      ]);
    } catch (e: any) {
      // 评审失败/超时：放行（不扰用户），服务端留痕便于排障
      diag.warn(
        "faithfulness-guard",
        "评审失败/超时，降级放行: " + (e?.message || e),
      );
      return; // 放行（不替换消息）
    }

    // 观测：忠实度软信号（含放行的低分），弥补 guard_hit 仅覆盖硬阻断的盲区
    logFaithfulness({
      action: verdict.action,
      score: typeof verdict.score === "number" ? verdict.score : undefined,
      reason: verdict.reasons || verdict.reason || undefined,
    }).catch((e: any) =>
      alert(
        "faithfulness-guard",
        `软信号观测失败，放行仍生效: ${e?.message || e}`,
      ),
    );

    // 真生效：annotate/block 档经 buildReplacementMessage 转替换消息并 return，
    // Pi 框架消费返回值（_replaceMessageInPlace）落地到最终回答；pass/无批注 → undefined 放行。
    if (verdict.action === "block" || verdict.action === "annotate") {
      const replacement = buildReplacementMessage(msg, verdict);
      if (replacement) {
        logGuardHit({
          type: "faithfulness",
          action: verdict.action,
          reason: verdict.reasons || verdict.reason || undefined,
        }).catch((e: any) =>
          alert(
            "faithfulness-guard",
            `埋点落盘失败，替换仍生效: ${e?.message || e}`,
          ),
        );
        return { message: replacement };
      }
    }
    // pass / 评审未触发批注：放行（不替换）
    return;
  });
}
