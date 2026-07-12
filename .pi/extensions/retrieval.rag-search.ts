import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchKnowledge } from "./lib/retrieval-router.mjs";
// 复用内置 KnowledgeEngine 实现真 hybrid + 重排（Opt2：内置优先 / DRY，BM25 作优雅回退）
import { engineHybridSearch } from "./lib/knowledge-engine-search.mjs";
// A 层增强：检索期版本冲突前置标注（复用 conflict-detector 零成本内核，单一真相源）
import { buildVersionConflictHint, defaultLoadGuideIndex } from "./lib/conflict-detector.mjs";

/**
 * rag_search 定向召回检索扩展（独立工具名，避免与 pi-knowledge 扩展的 knowledge_search 重名冲突）
 * -----------------------------------------------------------------------------------
 * 注册独立工具名 `rag_search`（注意：Pi 不允许两个扩展注册同名工具，故不可沿用
 * knowledge_search 去覆盖 pi-knowledge 扩展，否则加载器会拒载其一导致 KB 后端挂掉）。
 *
 * 检索策略（Opt2 · 内置优先 / DRY）：
 *   1) 始终先跑 guide_finder 语义路由 → 约束到命中指南文件（防真指南被压沉，原始卡死根因）；
 *      该路由 + BM25 召回零 e5 加载、瞬时，并兼作引擎失败时的优雅回退。
 *   2) dense 模式（hybrid / semantic / deep / adaptive）委托内置 KnowledgeEngine
 *      （lib/knowledge-engine-search.mjs 懒加载复用 pi-knowledge 的 e5 稠密向量与
 *      cross-encoder 重排），实现「真 hybrid」；fast 模式与引擎不可用时退回 BM25。
 *   - 拒绝手搓向量/重排：直接复用引擎与 vectors/<kb_id>.bin，保持单一真相源。
 *   - 引擎 import / 初始化 / 检索任一失败 → 回退 BM25 并显式告警，无静默失败。
 *
 * 行为保持兼容：沿用内置工具参数名（query/limit/kb_id/mode…），模型调用方式不变。
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
    // LLM 参数绑定宽松，按既有扩展惯例以 any 承接并显式标注
    execute: async (_toolCallId: string, params: any, signal?: any) => {
      const t0 = performance.now();
      const p = normalizeParams(params);
      const query = ((p.query || p.q || "") as string).toString().trim();
      if (!query) {
        return {
          content: [{ type: "text", text: "请提供检索内容（query）。" }],
        };
      }
      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 30) : 8;
      const kbId = typeof p.kb_id === "string" && p.kb_id ? p.kb_id : null;
      const mode = typeof p.mode === "string" ? p.mode : "hybrid";
      const telemetry: Record<string, any> = {
        query: query.slice(0, 60),
        mode,
        kbId: kbId || null,
        limit,
        t0,
      };

      // 始终先算 BM25 + 路由（廉价、无 e5 加载）：兼作（1）路由约束来源（2）引擎失败时的回退
      let out;
      const t1 = performance.now();
      try {
        out = searchKnowledge(query, { limit, kbId });
      } catch (e: any) {
        telemetry.error = "searchKnowledge_failed:" + (e?.message || e);
        console.warn("[rag_search.telemetry]", JSON.stringify(telemetry));
        return {
          content: [
            {
              type: "text",
              text: `知识库检索暂时不可用：${e?.message || e}\n建议改用 guide_finder 定位指南。`,
            },
          ],
        };
      }
      telemetry.bm25Ms = +(performance.now() - t1).toFixed(1);

      if (out.error) {
        telemetry.error = out.error;
        console.warn("[rag_search.telemetry]", JSON.stringify(telemetry));
        return {
          content: [
            {
              type: "text",
              text: `知识库未就绪（${out.error}）。请确认 pi-knowledge 已初始化，或改用 guide_finder。`,
            },
          ],
        };
      }

      telemetry.routedFiles = out.kbFiles.length;
      telemetry.totalFiles = out.totalFiles;

      const routedFilePaths = out.kbFiles && out.kbFiles.length ? out.kbFiles : null;
      const DENSE = new Set(["hybrid", "semantic", "deep", "adaptive"]);
      const dense = !mode || DENSE.has(mode);

      // dense 模式委托内置引擎（真 hybrid / 重排）；失败则回退 BM25，显式告警，无静默失败
      let engineResult = null;
      let engineWarn = null;
      if (dense) {
        const t2 = performance.now();
        engineResult = await engineHybridSearch(query, { mode, limit, kbId, routedFilePaths, signal });
        telemetry.engineMs = +(performance.now() - t2).toFixed(1);
        telemetry.engineOk = engineResult.ok;
        telemetry.engineMode = engineResult.ok ? (engineResult as any).modeUsed : null;
        if (!engineResult.ok) engineWarn = engineResult.error;
      }

      const engineUsed = dense && engineResult?.ok === true && engineResult.results.length > 0;
      const src = engineUsed ? engineResult : out;
      if (dense && !engineUsed) {
        engineWarn = (engineWarn ? engineWarn + "；" : "") + "引擎不可用，已回退 BM25";
        telemetry.engineFallback = true;
      }

      // A 层增强：检索期版本冲突前置标注（零成本）
      const t3 = performance.now();
      const versionWarn = buildVersionConflictHint(src.results, defaultLoadGuideIndex());
      telemetry.versionHintMs = +(performance.now() - t3).toFixed(1);

      telemetry.totalMs = +(performance.now() - t0).toFixed(1);
      telemetry.resultCount = src.results.length;
      telemetry.engineWarn = engineWarn || undefined;
      console.info("[rag_search.telemetry]", JSON.stringify(telemetry));

      const routed = out.routedTitles.length
        ? out.routedTitles.slice(0, 3).join("、")
        : "（路由未命中，已退化为全语料检索）";

      const perfLine = `[耗时] BM25:${telemetry.bm25Ms}ms${telemetry.engineMs ? ` 引擎:${telemetry.engineMs}ms` : ""} 总计:${telemetry.totalMs}ms`;
      const headerLines = [
        `[${engineUsed ? "引擎 hybrid" : "路由约束 BM25"}] 语义路由命中: ${routed}`,
        `约束文件: ${out.kbFiles.length} / 全库文件: ${out.totalFiles} | 模式: ${engineUsed ? (engineResult as any).modeUsed : "BM25 回退"}${engineWarn ? ` | ⚠️ ${engineWarn}` : ""}`,
        perfLine,
      ];
      if (versionWarn) headerLines.push(versionWarn);
      headerLines.push("");
      const header = headerLines.join("\n");

      if (src.results.length === 0) {
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

      const body = src.results
        .map((r: any, i: number) => {
          const cid = r.chunk_id ? ` chunk=${r.chunk_id}` : "";
          return `[${i + 1}] ${r.file_path} (score: ${r.score}${r.hitCount ? `, hits:${r.hitCount}` : ""}${cid})\n${r.snippet}`;
        })
        .join("\n\n");

      return { content: [{ type: "text", text: header + body }] };
    },
  });
}
