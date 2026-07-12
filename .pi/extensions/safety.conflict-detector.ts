import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { detectConflicts } from "./lib/conflict-detector.mjs";
import { logGuardHit } from "./lib/observability.mjs";

/**
 * conflict-detector 跨指南冲突检测扩展（方案 C · 先 B）
 * -----------------------------------------------------------------------------------
 * 在 Agent 生成最终回答后（on("message_end")）、回传前端前，自动检测「跨指南冲突」：
 *   Layer 1（零成本）：引用指南在 guide-index.json 中被标记 deprecated / supersededBy → 版本冲突批注；
 *   Layer 2（免费 LLM）：同一 query 命中 ≥2 份指南且推荐意见相左 → 内容冲突批注。
 * 命中冲突时仅「附加批注」而非拦截（保守分级，避免误伤），与原 faithfulness-guard 同构。
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

  pi.on("message_end", (event: any, ctx?: any) => {
    const message = event?.message;
    if (!message || message.role !== "assistant") return;
    const text = extractText(message.content);
    if (!text || !text.trim()) return;

    const questionFromEvent =
      event?.question || ctx?.question || extractLastUserQuestionFromCtx(ctx);
    const question = (questionFromEvent || _lastUserQuestion || "").toString().trim();
    if (!question) return;

    // 【关键】异步冲突检测：fire-and-forget，不阻塞 working 释放
    // 结果仅落地埋点，不修改 Pi 内部消息内容
    Promise.race([
      detectConflicts({ question, answer: text }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("conflict detection timeout")), 3000),
      ),
    ])
      .then((res: any) => {
        if (res.action === "annotate" && res.annotation) {
          logGuardHit({
            type: "conflict",
            action: "annotate",
            guides: (res.conflicts || [])
              .map((c: any) => (c.guide ? c.guide : (c.guides || []).join(" / ")))
              .filter(Boolean),
          }).catch(() => {});
        }
      })
      .catch(() => {
        // 评审超时/失败：静默放行，不输出到用户界面
      });
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

/** 在回答末尾追加批注（保留原回答，仅附加）。 */
function appendAnnotation(content: any, annotation: string): any {
  const sep = "\n\n";
  if (typeof content === "string") {
    return content + sep + annotation;
  }
  if (Array.isArray(content)) {
    return [
      ...content,
      { type: "text", text: sep + annotation },
    ];
  }
  // 兜底：包成数组
  return [
    { type: "text", text: extractText(content) },
    { type: "text", text: sep + annotation },
  ];
}
