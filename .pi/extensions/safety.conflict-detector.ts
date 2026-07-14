import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectConflicts, buildReplacementMessage } from "./lib/conflict-detector.mjs";
import { logGuardHit } from "./lib/observability.mjs";
// @ts-ignore —— 诊断统一出口，例程诊断落 logs/ 不污染终端
import { diag } from "./lib/diagnostic-log.mjs";
import { alert } from "./lib/alert-log.mjs";

/**
 * conflict-detector 跨指南冲突检测扩展（方案 C · 先 B）
 * -----------------------------------------------------------------------------------
 * 在 Agent 生成最终回答后（on("message_end")）、回传前端前，自动检测「跨指南冲突」：
 *   Layer 1（零成本）：引用指南在 guide-index.json 中被标记 deprecated / supersededBy → 版本冲突批注；
 *   Layer 2（免费 LLM）：同一 query 命中 ≥2 份指南且推荐意见相左 → 内容冲突批注。
 * 命中冲突时经 buildReplacementMessage 真替换回答末尾（保留原回答，防误伤），
 *   与原 faithfulness-guard 同构——async return { message } 由 Pi 框架消费（_replaceMessageInPlace）落地。
 *
 * 复用 lib/llm-judge 的 callLLM（免费优先），不在此自写端点；searchKnowledge 零成本。
 * 任一环节失败 → 放行（不阻断回答），仅记日志（无静默失败、也不误伤）。
 *
 * 触发：仅对 assistant 最终回答生效；工具结果 / 非文本消息直接放行。
 */

// 模块级缓存本轮 user 问题（供 message_end 取用），与 faithfulness-guard 各自独立作用域。
let _lastUserQuestion = "";
let _lastUserQuestionTs = 0;

export default function (pi: ExtensionAPI) {
  // 缓存用户最新问题（context 钩子每轮注入）
  pi.on("context", (_ctx: any) => {
    try {
      const msgs = _ctx?.messages || _ctx?.conversationContext?.messages || [];
      const lastUser = [...msgs].reverse().find((m: any) => m?.role === "user");
      if (lastUser) {
        const text = extractText(lastUser.content);
        if (text && text.trim()) {
          _lastUserQuestion = text.trim();
          _lastUserQuestionTs = Date.now();
        }
      }
    } catch {
      /* 缓存失败不阻断 */
    }
  });

  pi.on("message_end", async (event: any, ctx?: any) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    const text = extractText(message.content);
    if (!text || !text.trim()) return;

    const questionFromEvent =
      event?.question || ctx?.question || extractLastUserQuestionFromCtx(ctx);
    const question = (questionFromEvent || _lastUserQuestion || "").toString().trim();
    if (!question) return;

    // 异步冲突检测：await 结果，经 buildReplacementMessage 转为替换消息并 return，
    // Pi 框架消费返回值（_replaceMessageInPlace）真落地到最终回答。
    let res: any;
    try {
      res = await Promise.race([
        detectConflicts({ question, answer: text }),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("conflict detection timeout")), 3000),
        ),
      ]);
    } catch (e: any) {
      // 检测超时/失败：放行（不扰用户），服务端留痕便于排障
      diag.warn(
        "conflict-detector",
        "冲突检测失败/超时，降级放行: " + (e?.message || e),
      );
      return; // 放行（不替换）
    }

    if (res.action === "annotate" && res.annotation) {
      logGuardHit({
        type: "conflict",
        action: "annotate",
        guides: (res.conflicts || [])
          .map((c: any) => (c.guide ? c.guide : (c.guides || []).join(" / ")))
          .filter(Boolean),
      }).catch((e: any) =>
        alert(
          "conflict-detector",
          `埋点落盘失败，替换仍生效: ${e?.message || e}`,
        ),
      );
      // 真替换：在回答末尾附冲突批注（保持 role:assistant）
      return { message: buildReplacementMessage(message, res) };
    }

    // pass / 其他：放行（不替换）
    return;
  });
}

// ---------- 工具函数（与 faithfulness-guard 同构，独立实现避免跨扩展耦合） ----------
function extractText(content: any): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === "string" ? c : c?.type === "text" ? c.text || "" : ""))
      .join("");
  }
  if (typeof content === "object") {
    if (typeof content.text === "string") return content.text;
    if (Array.isArray(content.content)) return extractText(content.content);
  }
  return "";
}

function extractLastUserQuestionFromCtx(ctx: any): string {
  try {
    const msgs = ctx?.messages || ctx?.conversationContext?.messages || [];
    const lastUser = [...msgs].reverse().find((m: any) => m?.role === "user");
    return lastUser ? extractText(lastUser.content) : "";
  } catch {
    return "";
  }
}

// （appendAnnotation 已下沉至 lib/conflict-detector.mjs 的 buildReplacementMessage，避免跨文件重复实现）
