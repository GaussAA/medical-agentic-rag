import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore
import { decomposeQuery } from "./lib/query-transform.mjs";

/**
 * 查询分解工具
 *
 * 薄封装：核心逻辑由 query-transform.mjs 的 decomposeQuery() 提供，
 * 本扩展仅注册 LLM 可见的工具接口。消除了与 query-transform 的概念重叠。
 *
 * 注意：建议 LLM 优先使用 retrieve 工具统一检索，
 * 复杂多维度问题可调本工具分解后分别检索。
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "decompose_query",
    description:
      "将复杂的医学问题拆解为多个子查询。适用于对比类问题（如'比较A和B的治疗'）" +
      "或综合类问题（如'A的病因、诊断和治疗'）。拆解后逐一检索再汇总。",
    promptSnippet: "Decompose a complex medical question into sub-queries",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "用户的原始复杂问题",
        },
      },
      required: ["question"],
    },
    execute: async (_toolCallId: string, params: any) => {
      const question = ((params?.question || "") as string).trim();
      if (!question) {
        return { content: [{ type: "text", text: "请提供需要分解的问题。" }] };
      }
      const result = decomposeQuery(question);
      return { content: [{ type: "text", text: result.lines.join("\n") }] };
    },
  });
}
