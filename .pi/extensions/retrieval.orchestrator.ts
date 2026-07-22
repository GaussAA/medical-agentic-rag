/**
 * retrieval.orchestrator — 统一检索编排工具
 *
 * 将 guide_finder + rag_search + kg_search 封装为单一 `retrieve` 工具，
 * 内部自动决策检索策略（路由→模式选择→多路融合→KG补充），
 * 一次调用返回完整结果，消除 LLM 自行编排不可靠的根因。
 *
 * 注册工具名 `retrieve`（唯一入口，替代 guide_finder / rag_search / kg_search）
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// ── 内部模块（与 guide_finder / rag_search 引用相同）──
// @ts-ignore
import { routeGuides, loadIndex } from "./lib/guide-router.mjs";
// @ts-ignore
import { searchKnowledge } from "./lib/retrieval-router.mjs";
// @ts-ignore
import { searchKG } from "./lib/kg-search.mjs";
// @ts-ignore
import { generateQueryVariants } from "./lib/query-transform.mjs";
// @ts-ignore
import { rrfFusion } from "./lib/retrieval-router.mjs";
// @ts-ignore
import { sanitizeSearchQuery, correctMedicalQuery } from "./lib/query-sanitize.mjs";
// @ts-ignore
import { buildVersionConflictHint, defaultLoadGuideIndex, filterDeprecatedResults } from "./lib/conflict-detector.mjs";
// @ts-ignore
import { cacheGet, cacheSet } from "./lib/retrieval-cache.mjs";
// @ts-ignore
import { diag } from "./lib/diagnostic-log.mjs";

// ── 自动密集模式匹配（与 rag-search 同）──
const AUTO_DENSE_PATTERNS = [
  /诊断标准|诊断|实验室|检查|分级|分型|分期|分类/,
  /治疗路径|治疗流程|治疗方案|用药方案|阶梯|首选|一线|二线/,
  /剂量|用量|mg|每日|bid|tid|qd/,
  /禁忌|不良反应|副作用|警告|注意/,
];

function needsDenseMode(query: string): boolean {
  return AUTO_DENSE_PATTERNS.some((re) => re.test(query));
}

function extractText(text: any): string {
  if (typeof text === "string") return text;
  return "";
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "retrieve",
    description:
      "统一检索工具。根据用户问题，自动完成：指南定位 → 策略选型 → 定向检索 → 知识图谱补充，" +
      "一次性返回相关指南列表、证据切片和知识图谱实体。替代 guide_finder / rag_search / kg_search。",
    promptSnippet: "Unified medical knowledge retrieval: route->search->kg in one call",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "用户的医学问题或检索关键词（疾病/症状/药物/检查等），如《糖尿病特征》《高血压治疗》",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: any, signal?: any) => {
      const t0 = performance.now();
      const p = params || {};
      const rawQuery = ((p.query || "") as string).toString().trim();
      if (!rawQuery) {
        return { content: [{ type: "text", text: "请提供检索关键词。" }] };
      }

      // ── 查询脱敏与纠错 ──
      let query = sanitizeSearchQuery(rawQuery);
      const corrected = correctMedicalQuery(query);
      if (corrected !== query) {
        diag.info("retrieve", `CRAG纠错: "${query.slice(0, 40)}" → "${corrected.slice(0, 40)}"`);
        query = corrected;
      }

      // ── 缓存检查 ──
      const cacheKey = `retrieve:${query}`;
      const cached = cacheGet(cacheKey);
      if (cached) {
        diag.info("retrieve", `缓存命中: "${query.slice(0, 40)}"`);
        return cached;
      }

      const log: string[] = [];
      const errors: string[] = [];

      // ── 阶段1：指南路由 ──
      let guides: any[] = [];
      let topDisease = "";
      try {
        const index = loadIndex();
        const routeResult = routeGuides(query, { index, topK: 5 });
        guides = (routeResult.top || []).map((g: any) => ({
          title: g.title,
          disease: g.disease,
          score: +(g.score || 0).toFixed(1),
          version: g.version || null,
        }));
        log.push(`路由: ${guides.length} 份指南命中，Top="${guides[0]?.title || "无"}"`);
        // 取 Top-1 疾病作为 KG 查询目标
        topDisease = guides[0]?.disease || "";
      } catch (e: any) {
        errors.push("路由失败: " + (e?.message || e));
      }

      // ── 阶段2：策略选型 ──
      const limit = 10;
      const autoDense = needsDenseMode(query);
      const mode = autoDense ? "hybrid" : "fast";
      log.push(`模式: ${mode}（${autoDense ? "自动hybrid" : "fast"}）`);

      // ── 阶段3：检索（自动 MultiQuery 升级） ──
      let results: any[] = [];
      let lowConfidence = false;
      let engineMode = "bm25";

      try {
        let out = searchKnowledge(query, { limit });
        lowConfidence = out?.lowConfidence || false;
        engineMode = out?.kbFiles?.length > 0 ? "bm25_routed" : "bm25";

        // 始终尝试 MultiQuery 提升召回（短超时 3s）
        let fused = false;
        try {
          const variants = await generateQueryVariants(query, { timeoutMs: 3000 });
          if (variants.length > 1) {
            const bm25Results = [out.results || []];
            for (const v of variants.slice(1)) {
              const r = searchKnowledge(v, { limit });
              if (r?.results?.length) bm25Results.push(r.results);
            }
            if (bm25Results.length > 1) {
              out = {
                ...out,
                results: rrfFusion(bm25Results, 60, limit),
              };
              engineMode = "bm25_multi";
              fused = true;
              log.push("MultiQuery 融合: " + variants.length + " 变体");
            }
          }
        } catch {
          /* MultiQuery 降级 */
        }

        // 低置信时升级 hybrid
        if (lowConfidence && !fused && autoDense) {
          // 首次 BM25 已低置信，再次搜索用原有路径
          const retry = searchKnowledge(query, { limit });
          if (retry?.results?.length > (out?.results?.length || 0)) {
            out = retry;
            engineMode = "bm25_retry";
            log.push("低置信重试");
          }
        }

        // 版本冲突标注 & 废止过滤
        try {
          const gm = defaultLoadGuideIndex();
          out.results = filterDeprecatedResults(out.results || [], gm);
        } catch {
          /* 过滤失败不阻断 */
        }

        results = (out?.results || []).slice(0, limit).map((r: any) => ({
          text: (r.snippet || "").slice(0, 300),
          file: r.file_path || "",
          score: +(r.score || 0).toFixed(1),
          chunkId: r.chunk_id || "",
        }));
        log.push(`检索: ${results.length} 条切片, 引擎=${engineMode}`);
      } catch (e: any) {
        errors.push("检索失败: " + (e?.message || e));
      }

      // ── 阶段4：知识图谱补充 ──
      let kgSymptoms: string[] = [];
      let kgDrugs: string[] = [];
      let kgExams: string[] = [];
      let kgRisks: string[] = [];
      let kgTreatments: string[] = [];

      if (topDisease) {
        try {
          const kgResult = searchKG({ disease: topDisease }, { useCache: true });
          if (kgResult.count > 0) {
            // 从文本结果中按类型分组
            const lines = (kgResult.text || "").split("\n");
            let currentType = "";
            for (const line of lines) {
              const symMatch = line.match(/^\s*症状:\s*(.+)/);
              const drugMatch = line.match(/^\s*药物:\s*(.+)/);
              const examMatch = line.match(/^\s*检查:\s*(.+)/);
              const riskMatch = line.match(/^\s*危险因素:\s*(.+)/);
              const treatMatch = line.match(/^\s*治疗:\s*(.+)/);
              if (symMatch) kgSymptoms.push(...symMatch[1].split("、").map((s: string) => s.trim()));
              if (drugMatch) kgDrugs.push(...drugMatch[1].split("、").map((s: string) => s.trim()));
              if (examMatch) kgExams.push(...examMatch[1].split("、").map((s: string) => s.trim()));
              if (riskMatch) kgRisks.push(...riskMatch[1].split("、").map((s: string) => s.trim()));
              if (treatMatch) kgTreatments.push(...treatMatch[1].split("、").map((s: string) => s.trim()));
            }
            log.push(`KG: ${kgSymptoms.length}症状 ${kgDrugs.length}药物 ${kgExams.length}检查`);
          }
        } catch {
          /* KG 降级 */
        }
      }

      // ── 阶段5：组装返回结果 ──
      const header = [
        "━━━ 检索报告 ━━━",
        `查询: "${rawQuery}"`,
        `策略: ${mode} | 引擎: ${engineMode} | 耗时: ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        ...(lowConfidence ? ["⚠️ 低置信: 路由未锁定高相关指南，检索结果相关性存疑"] : []),
        ...(errors.map((e) => `⚠️ ${e}`)),
        "",
        "─ 相关指南 ─",
        ...(guides.length ? guides.map((g, i) => `  ${i + 1}. ${g.title} (score=${g.score})`) : ["  （无匹配指南）"]),
        "",
        "─ 证据切片（Top-10） ─",
        ...(results.length
          ? results.map(
              (r, i) =>
                `  [${i + 1}] ${r.file} (score=${r.score}${r.chunkId ? ` chunk=${r.chunkId}` : ""})\n    ${r.text.slice(0, 200)}`,
            )
          : ["  （未检索到相关内容）"]),
      ];

      const kgSection =
        kgSymptoms.length || kgDrugs.length || kgExams.length || kgRisks.length || kgTreatments.length
          ? [
              "",
              "─ 知识图谱（疾病: " + topDisease + "） ─",
              ...(kgSymptoms.length ? [`  症状: ${kgSymptoms.slice(0, 10).join("、")}`] : []),
              ...(kgDrugs.length ? [`  药物: ${kgDrugs.slice(0, 10).join("、")}`] : []),
              ...(kgExams.length ? [`  检查: ${kgExams.slice(0, 10).join("、")}`] : []),
              ...(kgRisks.length ? [`  危险因素: ${kgRisks.slice(0, 10).join("、")}`] : []),
              ...(kgTreatments.length ? [`  治疗: ${kgTreatments.slice(0, 10).join("、")}`] : []),
            ]
          : [];

      const body = [...header, ...kgSection].join("\n");

      const result = { content: [{ type: "text" as const, text: body }] };

      // ── 写入缓存 ──
      try {
        cacheSet(cacheKey, result, 300_000);
      } catch {
        /* 缓存失败不阻断 */
      }

      // ── 观测日志 ──
      diag.info("retrieve", JSON.stringify({
        query: query.slice(0, 40),
        mode,
        engineMode,
        guides: guides.length,
        results: results.length,
        kgSymptoms: kgSymptoms.length,
        ms: (performance.now() - t0).toFixed(0),
        errors: errors.length,
      }));

      return result;
    },
  });
}
