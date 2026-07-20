import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchKnowledge } from "./lib/retrieval-router.mjs";
// 复用内置 KnowledgeEngine 实现真 hybrid + 重排（Opt2：内置优先 / DRY，BM25 作优雅回退）
import { engineHybridSearch } from "./lib/knowledge-engine-search.mjs";
// A 层增强：检索期版本冲突前置标注（复用 conflict-detector 零成本内核，单一真相源）
import { buildVersionConflictHint, defaultLoadGuideIndex, filterDeprecatedResults } from "./lib/conflict-detector.mjs";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { sanitizeSearchQuery, correctMedicalQuery } from "./lib/query-sanitize.mjs";
// P1 增强：RRF 多通道结果融合
import { rrfFusion } from "./lib/retrieval-router.mjs";
// P1 增强：查询改写（MultiQuery 语义等价问法生成）
// @ts-ignore
import { generateQueryVariants } from "./lib/query-transform.mjs";
// 检索动作落入防篡改审计哈希链（仅记字段名，不记查询原文——合规红线）
import { auditChainLog } from "./lib/audit-chain.mjs";
import { logRetrieval, logEngineFallback } from "./lib/observability.mjs";
// @ts-ignore —— 诊断统一出口，例程诊断落 logs/ 不污染终端
import { diag } from "./lib/diagnostic-log.mjs";
import { alert } from "./lib/alert-log.mjs";
// @ts-ignore —— 参数归一化（Pi 框架三种传参格式变体）
import { normalizeParams } from "./lib/parse-params.mjs";

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

// 防止 LLM 反复重搜的调用计数硬上限（代码层禁止，不依赖 LLM 自觉）
const MAX_RAG_SEARCH_CALLS = 2;
let _callCount = 0;
let _callKey = "";

export default function (pi: ExtensionAPI) {
  // 每轮用户新问题重置检索计数器 & 注入工具使用禁令
  pi.on("context", (event: any) => {
    // 重置计数器
    try {
      const msgs: any[] = (event && event.messages) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === "user") {
          const text = (typeof msgs[i].content === "string" ? msgs[i].content : "") || "";
          const key = text.slice(0, 100);
          if (key !== _callKey) { _callKey = key; _callCount = 0; }
          break;
        }
      }
    } catch { /* 不影响主流程 */ }
    // 注入工具禁令：knowledge_search / knowledge_symbol_search 已停用（仅保留 rag_search / guide_finder）
    // 因 Pi 不允许同名工具覆盖，无法从工具注册层面禁掉 pi-knowledge 的 knowledge_search，
    // 故在 context 层注入系统指令，确保 LLM 每轮调用前都看到禁令。
    return {
      messages: [
        {
          role: "system",
          content: "⚠️ 工具使用禁令：knowledge_search、knowledge_symbol_search 等旧版检索工具已停用，**严禁调用**。所有检索请使用 rag_search 或 guide_finder。",
        },
        ...(event.messages || []),
      ],
    };
  });

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
      "⚠️ 禁用多次检索：rag_search 默认 fast 模式（<1s）。若返回结果不理想，不得换词重试——直接如实告知用户该主题知识库可能未收录专项指南。dense 模式(hybrid/semantic/deep/adaptive)仅限极少数需要语义排名的场景，单次 24-130s。",
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
            "检索模式：默认 fast（BM25+路由，<1s）。hybrid/semantic/deep/adaptive 走 dense 委托 KnowledgeEngine 真 hybrid（含 bge 重排，单次 24-130s），仅在极少数需要语义排名时使用；引擎不可用自动回退 BM25。性能提示：dense 模式在 e5 本地嵌入时间不长，请优先 fast。",
        },
      },
      required: ["query"],
    },
    // LLM 参数绑定宽松，按既有扩展惯例以 any 承接并显式标注
    execute: async (_toolCallId: string, params: any, signal?: any) => {
      const t0 = performance.now();
      // 🔴 检索次数硬上限：LLM 无视"仅检索一次"铁律时的终极防线。
      // 代码层限制单轮用户问题仅允许 MAX_RAG_SEARCH_CALLS 次检索，
      // 超限后直接返回阻断消息，从根本上杜绝铁律沦丧。
      _callCount++;
      if (_callCount > MAX_RAG_SEARCH_CALLS) {
        return {
          content: [{
            type: "text",
            text: `⚠️ 检索次数已达上限（${MAX_RAG_SEARCH_CALLS} 次）。请据实告知用户：该主题知识库已检索完毕未找到更佳匹配，不能换词继续搜索。`,
          }],
        };
      }
      const p = normalizeParams(params);
      const rawQuery = ((p.query || p.q || "") as string).toString().trim();
      // 强制脱敏：避免患者 PII 进入检索上下文与查询日志（合规红线）
      let query = sanitizeSearchQuery(rawQuery);
      if (!query) {
        return {
          content: [{ type: "text", text: "请提供检索内容（query）。" }],
        };
      }
      // P1 CRAG 增强：医疗查询纠错（同音字/缩写/术语补全）
      const correctedQuery = correctMedicalQuery(query);
      if (correctedQuery !== query) {
        diag.info("rag_search", `CRAG 纠错: "${query.slice(0, 40)}" → "${correctedQuery.slice(0, 40)}"`);
        query = correctedQuery;
      }

      const limit = typeof p.limit === "number" && p.limit > 0 ? Math.min(p.limit, 30) : 8;
      const kbId = typeof p.kb_id === "string" && p.kb_id ? p.kb_id : null;
      // 审计：检索动作落入防篡改哈希链（仅字段名，不含查询原文——合规红线）
      try {
        auditChainLog("retrieval", { queryLen: query.length, kbId: kbId || null });
      } catch {
        /* 审计写入失败绝不阻断检索 */
      }
      // P0 性能优化：默认 fast（BM25+路由，<1s），dense 模式由 LLM 按需指定
      const mode = typeof p.mode === "string" ? p.mode : "fast";
      const telemetry: Record<string, any> = {
        query: query.slice(0, 60),
        mode,
        kbId: kbId || null,
        limit,
        t0,
      };

      // 查询改写优化：先快速单路 BM25 试水温，仅低置信时升级为多路 RRF 融合
      // 避免每次检索都等 8s 变体生成（大多数正常查询单路 BM25 <1s 即可出结果）
      let searchQueries: string[] = [query];
      const DENSE = new Set(["hybrid", "semantic", "deep", "adaptive"]);
      const dense = !mode || DENSE.has(mode);

      let out;
      const t1 = performance.now();
      if (dense) {
        // dense 模式不变：引擎端仅用原始 query（避免 3×引擎开销）
        out = searchKnowledge(query, { limit, kbId });
      } else {
        // Fast path：单路 BM25 试水温（<1s）
        out = searchKnowledge(query, { limit, kbId });
        telemetry.bm25Ms = +(performance.now() - t1).toFixed(1);

        // 仅当低置信且结果不足时升级为多路变体 + RRF 融合
        if (out && out.lowConfidence && (!out.results || out.results.length < 3)) {
          try {
            const variants = await generateQueryVariants(query, { timeoutMs: 8000 });
            if (variants.length > 1) {
              searchQueries = variants;
              telemetry.queryVariants = variants.length;
              telemetry.queriesUsed = variants.map((v: string) => v.slice(0, 30));
              // 多路 BM25 + RRF 融合
              const t1b = performance.now();
              const bm25Results = [];
              for (const q of searchQueries) {
                const r = searchKnowledge(q, { limit, kbId });
                if (r && r.results && r.results.length) bm25Results.push(r.results);
              }
              if (bm25Results.length > 1) {
                const fused = rrfFusion(bm25Results, 60, limit);
                const base = searchKnowledge(searchQueries[0], { limit: 1, kbId });
                out = {
                  results: fused,
                  routedTitles: base?.routedTitles || [],
                  kbFiles: base?.kbFiles || [],
                  constrained: base?.constrained || false,
                  lowConfidence: base?.lowConfidence || false,
                  topScore: base?.topScore || 0,
                  totalFiles: base?.totalFiles || 0,
                };
                telemetry.bm25Ms = +(performance.now() - t1b).toFixed(1);
              }
            }
          } catch (e: any) {
            diag.info("rag_search", "查询改写降级: " + (e?.message || e));
          }
        } else {
          telemetry.bm25Ms = +(performance.now() - t1).toFixed(1);
        }
      }

      if (out.error) {
        telemetry.error = out.error;
        diag.warn("rag_search", "telemetry: " + JSON.stringify(telemetry));
        return {
          content: [
            {
              type: "text",
              text: `知识库未就绪（${out.error}）。请确认 pi-knowledge 已初始化，或改用 guide_finder。`,
            },
          ],
        };
      }

      telemetry.routedFiles = out.kbFiles ? out.kbFiles.length : 0;
      telemetry.totalFiles = out.totalFiles;
      telemetry.lowConfidence = out.lowConfidence || undefined;

      const routedFilePaths = out.kbFiles && out.kbFiles.length ? out.kbFiles : null;

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
        // 观测：引擎回退 BM25 信号（脆弱点可见化），fire-and-forget 不阻断
        logEngineFallback({
          reason: engineResult?.error || "engine_unavailable",
        }).catch((e: any) =>
          alert("rag_search", `引擎回退观测失败: ${e?.message || e}`),
        );
      }

      // A 层增强：检索期版本冲突前置标注（零成本）
      const t3 = performance.now();
      const versionWarn = buildVersionConflictHint(src.results, defaultLoadGuideIndex());
      telemetry.versionHintMs = +(performance.now() - t3).toFixed(1);

      // P0 安全闭环：硬剔除已废止 / 有更新版指南 chunk，杜绝 Agent 引用过时版本给出陈旧推荐。
      // 告警仍基于剔除前结果生成（保留透明提示），正文仅含现行版 chunk。
      const _gm = defaultLoadGuideIndex();
      const _filtered = filterDeprecatedResults(src.results, _gm);
      if (_filtered.length > 0) src.results = _filtered;

      telemetry.totalMs = +(performance.now() - t0).toFixed(1);
      telemetry.resultCount = src.results.length;
      telemetry.engineWarn = engineWarn || undefined;
      diag.info("rag_search", "telemetry: " + JSON.stringify(telemetry));
      // 观测：检索维度埋点（召回条数/耗时/引擎模式），fire-and-forget 不阻断
      logRetrieval({
        queryLen: query.length,
        kbId,
        kbResolved: !!(out && out.kbFiles && out.kbFiles.length),
        hits: telemetry.resultCount,
        totalFiles: telemetry.totalFiles,
        ms: telemetry.totalMs,
        engineMode: engineUsed ? (engineResult as any).modeUsed : "bm25_fallback",
      }).catch((e: any) =>
        alert("rag_search", `检索观测写入失败: ${e?.message || e}`),
      );

      const routedLabel = out.lowConfidence
        ? "（低置信：路由未锁定高相关指南，已退化为全语料检索）"
        : out.routedTitles.length
        ? out.routedTitles.slice(0, 3).join("、")
        : "（路由未命中，已退化为全语料检索）";

      const perfLine = `[耗时] BM25:${telemetry.bm25Ms}ms${telemetry.engineMs ? ` 引擎:${telemetry.engineMs}ms` : ""} 总计:${telemetry.totalMs}ms`;
      const headerLines = [
        `[${engineUsed ? "引擎 hybrid" : "路由约束 BM25"}] 语义路由: ${routedLabel}`,
        `约束文件: ${out.kbFiles ? out.kbFiles.length : 0} / 全库文件: ${out.totalFiles} | 模式: ${engineUsed ? (engineResult as any).modeUsed : "BM25 回退"}${engineWarn ? ` | ⚠️ ${engineWarn}` : ""}`,
        perfLine,
      ];
      if (out.lowConfidence) {
        // P1 根治：弱分空转。显式告诉 LLM 路由未锁定高相关指南，下方结果相关性存疑，
        // 勿再换近义词反复重搜，应据实告知用户「该主题知识库可能未收录专项指南」。
        headerLines.push(
          "⚠️ 低置信召回：语义路由未锁定高相关指南，下方结果相关性存疑。" +
          "若多次检索均弱相关，请据实告知用户「该主题知识库可能未收录专项指南」，切勿反复换词空转。",
        );
      }
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
