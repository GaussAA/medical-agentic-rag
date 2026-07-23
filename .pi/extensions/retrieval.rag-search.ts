/**
 * rag_search 扩展 — 已废弃注册，仅保留 context 钩子用于注入旧工具禁令
 *
 * 该工具已由 retrieval.orchestrator.ts 的 `retrieve` 工具替代。
 * 【registerTool 已移除】：旧版的 rag_search 工具不再向 LLM 公开，
 * 避免 LLM 在工具选择面板中看到已废弃的工具名造成困惑。
 *
 * 【保留上下文钩子】：Pi 框架不允许运行时注销已注册工具（如 pi-knowledge
 * 的 knowledge_search），故通过 on("context") 每轮注入禁令消息，
 * 防止 LLM 调用 knowledge_search/knowledge_symbol_search 等旧版工具。
 *
 * 检索管线逻辑由 retrieval.orchestrator.ts 内部直接调用 lib 模块完成。
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // 每轮注入旧版检索工具禁令（Pi 不允许运行时注销 registerTool，故用 context 层拦截）
  pi.on("context", (event: any) => {
    return {
      messages: [
        {
          role: "system",
          content:
            "⚠️ 工具使用禁令：knowledge_search、knowledge_symbol_search、" +
            "guide_finder、rag_search、kg_search 等旧版检索工具已停用，**严禁调用**。" +
            "所有检索请统一使用 **retrieve** 工具（一次调用返回完整检索报告）。",
        },
        ...(event.messages || []),
      ],
    };
  });
}
