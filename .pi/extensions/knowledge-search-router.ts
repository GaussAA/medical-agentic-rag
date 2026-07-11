import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchKnowledge } from "./lib/retrieval-router.mjs";

/**
 * rag_search 定向召回检索扩展（独立工具名，避免与 pi-knowledge 扩展的 knowledge_search 重名冲突）
 * -----------------------------------------------------------------------------------
 * 注册独立工具名 `rag_search`（注意：Pi 不允许两个扩展注册同名工具，故不可沿用
 * knowledge_search 去覆盖 pi-knowledge 扩展，否则加载器会拒载其一导致 KB 后端挂掉）。
 * 在检索前先跑 guide_finder 的语义路由，
 * 锁定应检索的指南文件名，再约束到该指南的 chunks 做 BM25 召回，
 * 避免真指南被无关文档压沉（原始会话卡死的根因之一）。
 *
 * 为何自包含实现（不调用 pi-knowledge 引擎）：
 *   - pi-knowledge 仅导出 default 扩展函数，engine 私有，外部无法直连 engine.search；
 *   - jiti 每扩展独立实例化，二次 import 会触发分钟级重型初始化（加载 e5 模型）；
 *   - ExtensionAPI 不提供运行期调用其他工具的接口。
 * 故直接读 pi-knowledge 的 SQLite（chunks 快照）做 BM25，瞬时、零耦合、无二次 init。
 *
 * 行为保持兼容：沿用内置工具的参数名（query/limit/kb_id/mode…），模型调用方式不变。
 * 路由命中 KB 文件 → 约束召回（高精度）；未命中 → 退化为全语料 BM25（不丢召回）。
 */

function normalizeParams(params: any) {
  let p = params;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      /* 保持原样 */
    }
  }
  if (p && typeof p === "object" && typeof p.arguments === "string") {
    try {
      p = JSON.parse(p.arguments);
    } catch {
      /* 保持原样 */
    }
  } else if (p && typeof p === "object" && typeof p.arguments === "object") {
    p = p.arguments;
  }
  return p || {};
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "rag_search",
    label: "RAG Search (routed)",
    description:
      "在已索引的医疗指南知识库中检索相关内容。先经语义路由锁定最相关指南，再定向召回，避免无关文档干扰。" +
      "支持 BM25 词元召回（中文单字+二元组、拉丁词、医学同义词扩展）。",
    promptSnippet: "Search medical guidelines with semantic-route-constrained BM25 recall",
    promptGuidelines: [
      "先用 guide_finder 定位相关疾病/症状对应的指南（语义路由），本工具会自动据此约束召回范围",
      "对医疗领域问题默认使用本工具获取依据，再作答",
      "若返回结果明显偏弱，可换用更具体的查询词重试一次",
    ],
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "检索内容（疾病名称、症状、药物、检查等）",
        },
        limit: {
          type: "number",
          description: "返回结果数量上限，默认 8",
        },
        kb_id: {
          type: "string",
          description: "指定知识库 ID（可选，默认全库）",
        },
        mode: {
          type: "string",
          description:
            "兼容占位参数（hybrid/semantic/fast/adaptive/deep）；本覆盖版统一使用路由约束 BM25",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: any) => {
      const p = normalizeParams(params);
      const query = ((p.query || p.q || "") as string).toString().trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "请提供检索内容（query）。" }],
        };
      }
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 30) : 8;
      const kbId = typeof p.kb_id === "string" && p.kb_id ? p.kb_id : null;

      let out;
      try {
        out = searchKnowledge(query, { limit, kbId });
      } catch (e: any) {
        return {
          content: [
            {
              type: "text",
              text: `知识库检索暂时不可用：${e?.message || e}\n建议改用 guide_finder 定位指南。`,
            },
          ],
        };
      }

      if (out.error) {
        return {
          content: [
            {
              type: "text",
              text: `知识库未就绪（${out.error}）。请确认 pi-knowledge 已初始化，或改用 guide_finder。`,
            },
          ],
        };
      }

      const routed = out.routedTitles.length
        ? out.routedTitles.slice(0, 3).join("、")
        : "（路由未命中，已退化为全语料检索）";
      const header = [
        `[路由定向召回] 语义路由命中: ${routed}`,
        `约束文件: ${out.kbFiles.length} / 全库文件: ${out.totalFiles} | 模式: ${out.constrained ? "约束召回" : "全语料回退"}`,
        "",
      ].join("\n");

      if (out.results.length === 0) {
        return {
          content: [
            {
              type: "text",
              text:
                header +
                `未检索到与"${query}"相关的指南内容。可能该主题尚未收录，或请换用更具体的查询词。`,
            },
          ],
        };
      }

      const body = out.results
        .map((r: any, i: number) => {
          return `[${i + 1}] ${r.file_path} (score: ${r.score}${r.hitCount ? `, hits:${r.hitCount}` : ""})\n${r.snippet}`;
        })
        .join("\n\n");

      return { content: [{ type: "text", text: header + body }] };
    },
  });
}
