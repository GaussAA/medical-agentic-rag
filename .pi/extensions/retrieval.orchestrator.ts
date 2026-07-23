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
import { hydeRetrieve } from "./lib/query-transform/hyde.mjs";
// @ts-ignore
import { rrfFusion } from "./lib/retrieval-router.mjs";
// @ts-ignore
import { engineHybridSearch } from "./lib/knowledge-engine-search.mjs";
// @ts-ignore
import { progressivePipeline } from "./lib/retrieval-router/progressive-rerank.mjs";
// @ts-ignore
import { sanitizeSearchQuery, correctMedicalQuery } from "./lib/query-sanitize.mjs";
// @ts-ignore
import { buildVersionConflictHint, defaultLoadGuideIndex, filterDeprecatedResults } from "./lib/conflict-detector.mjs";
// @ts-ignore
import { cacheGet, cacheSet, cacheGetAsync } from "./lib/retrieval-cache.mjs";
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

      // ── 缓存检查（异步三级：内存→Redis→文件）──
      const cacheKey = `retrieve:${query}`;
      const cached = await cacheGetAsync(cacheKey);
      if (cached) {
        diag.info("retrieve", `缓存命中: "${query.slice(0, 40)}"`);
        return cached;
      }

      const log: string[] = [];
      const errors: string[] = [];

      // ── 阶段1：指南路由 ──
      let guides: any[] = [];
      let topDisease = "";
      let detectedDept: string | null = null;
      try {
        const index = loadIndex();
        const routeResult = routeGuides(query, { index, topK: 5 });
        detectedDept = (routeResult as any).detectedDept || null;
        guides = (routeResult.top || []).map((g: any) => ({
          title: g.title,
          disease: g.disease,
          score: +(g.score || 0).toFixed(1),
          version: g.version || null,
          department: g.department || null,
        }));
        log.push(`路由: ${guides.length} 份指南命中，Top="${guides[0]?.title || "无"}"${detectedDept ? `，科室=${detectedDept}` : ""}`);
        // 取 Top-1 疾病作为 KG 查询目标
        topDisease = guides[0]?.disease || "";
      } catch (e: any) {
        errors.push("路由失败: " + (e?.message || e));
      }

      // ── 阶段2：策略选型 ──
      const finalLimit = 10;
      const fetchLimit = 100; // BM25 取更多候选供渐进式重排序
      const denseLimit = 20;  // Dense 引擎代价较高，取更少候选
      const autoDense = needsDenseMode(query);
      const mode = autoDense ? "hybrid" : "fast";
      log.push(`模式: ${mode}（${autoDense ? "自动hybrid" : "fast"}）`);

      // ── 阶段3：检索（双通道 + 多路融合） ──
      let results: any[] = [];
      let lowConfidence = false;
      let engineMode = "bm25";

      try {
        // ── 3a: SPARSE 通道（BM25 + MultiQuery + HyDE）──
        let out = searchKnowledge(query, { limit: fetchLimit });
        lowConfidence = out?.lowConfidence || false;
        engineMode = out?.kbFiles?.length > 0 ? "bm25_routed" : "bm25";

        // 始终尝试 MultiQuery 提升召回（短超时 3s）
        let fused = false;
        try {
          const variants = await generateQueryVariants(query, { timeoutMs: 3000 });
          if (variants.length > 1) {
            const bm25Results = [out.results || []];
            for (const v of variants.slice(1)) {
              const r = searchKnowledge(v, { limit: fetchLimit });
              if (r?.results?.length) bm25Results.push(r.results);
            }
            if (bm25Results.length > 1) {
              out = {
                ...out,
                results: rrfFusion(bm25Results, 60, fetchLimit),
              };
              engineMode = "bm25_multi";
              fused = true;
              log.push("MultiQuery 融合: " + variants.length + " 变体");
            }
          }
        } catch {
          /* MultiQuery 降级 */
        }

        // 低置信时重试
        if (lowConfidence && !fused && autoDense) {
          const retry = searchKnowledge(query, { limit: fetchLimit });
          if (retry?.results?.length > (out?.results?.length || 0)) {
            out = retry;
            engineMode = "bm25_retry";
            log.push("低置信重试");
          }
        }

        // HyDE 假设文档扩展
        let hydeApplied = false;
        try {
          const hydeResult = await hydeRetrieve(query, (q: string, o: any) => searchKnowledge(q, o), {
            limit: fetchLimit,
            hydeTimeoutMs: 5000,
          });
          if (hydeResult.hydeApplied && hydeResult.results.length > 0) {
            out = { ...out, results: hydeResult.results };
            hydeApplied = true;
            engineMode = engineMode.includes("hyde") ? engineMode : engineMode + "_hyde";
            log.push("HyDE: 假设答案检索融合完成");
          }
        } catch {
          /* HyDE 降级 */
        }

        // ── 3b: DENSE 通道（e5 向量 + bge-reranker），仅 autoDense 模式 ──
        // 与 SPARSE 并行执行，超时 8s 降级，不阻塞主流程
        if (autoDense) {
          try {
            const denseResult = await engineHybridSearch(query, {
              mode: "hybrid",
              limit: denseLimit,
              signal: AbortSignal.timeout(8000),
            });
            if (denseResult.ok && denseResult.results.length > 0) {
              const sparseResults = out.results || [];
              const beforeCount = sparseResults.length;
              out = {
                ...out,
                results: rrfFusion([sparseResults, denseResult.results], 60, fetchLimit),
              };
              engineMode = "hybrid_dense";
              log.push(`Dense 融合: ${beforeCount}sparse + ${denseResult.results.length}dense → ${(out.results || []).length} 条 (${denseResult.latencyMs}ms)`);
            } else {
              log.push(`Dense 通道未返回结果: ${denseResult.error || "空结果"}`);
            }
          } catch (e: any) {
            log.push(`Dense 通道降级: ${e?.message || e}`);
          }
        }

        // ── 3c: 渐进式重排序 ──
        if (out?.results?.length > 0) {
          const before = out.results.length;
          out.results = progressivePipeline(out.results, query, {
            initialTopK: fetchLimit,
            finalTopK: finalLimit,
          });
          log.push(`渐进式重排序: ${before} → ${out.results.length} 条`);
        }

        // 版本冲突标注 & 废止过滤
        try {
          const gm = defaultLoadGuideIndex();
          out.results = filterDeprecatedResults(out.results || [], gm);
        } catch {
          /* 过滤失败不阻断 */
        }

        // ── 源内去重 + MMR 多样性重排序 ──
        // 避免同一指南独占 Top-N；引入后确保 Top-3 覆盖至少 2 个不同指南
        try {
          if (out?.results?.length > 1) {
            const perFileLimit = 3;
            const fileCount = new Map<string, number>();
            const deduped: any[] = [];
            for (const r of out.results) {
              const key = (r.file_path || r.file || "") as string;
              const cnt = (fileCount.get(key) || 0) + 1;
              if (cnt > perFileLimit) continue;
              fileCount.set(key, cnt);
              deduped.push(r);
            }
            const dedupLog = `${out.results.length} → ${deduped.length} 条(去重)`;
            out.results = deduped;

            // MMR 贪心重排序
            const topK = Math.min(deduped.length, finalLimit);
            const mmrResults: any[] = [];
            const selectedSources = new Set<string>();
            const candidates = [...deduped];
            while (mmrResults.length < topK && candidates.length > 0) {
              let bestIdx = 0;
              let bestScore = -Infinity;
              for (let i = 0; i < candidates.length; i++) {
                const c = candidates[i];
                const source = (c.file_path || c.file || "") as string;
                const simToSelected = selectedSources.size > 0
                  ? (selectedSources.has(source) ? 1 : 0)
                  : 0;
                const lambda = 0.7;
                const relevance = (c as any).refinedScore ?? (c.score || 0);
                const mmrScore = lambda * relevance - (1 - lambda) * simToSelected;
                if (mmrScore > bestScore) { bestScore = mmrScore; bestIdx = i; }
              }
              const s = candidates.splice(bestIdx, 1)[0];
              const src = (s.file_path || s.file || "") as string;
              selectedSources.add(src);
              mmrResults.push(s);
            }
            const mmrLog = `MMR: ${candidates.length}候选→${mmrResults.length}条(${selectedSources.size}来源)`;
            out.results = mmrResults;
            log.push(`${dedupLog}, ${mmrLog}`);
          }
        } catch (e: any) {
          log.push(`去重/多样性跳过: ${e?.message || e}`);
        }

        results = (out?.results || []).slice(0, finalLimit).map((r: any) => ({
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
        `策略: ${mode} | 引擎: ${engineMode}${detectedDept ? ` | 科室: ${detectedDept}` : ""} | 耗时: ${((performance.now() - t0) / 1000).toFixed(1)}s`,
        ...(lowConfidence ? ["⚠️ 低置信: 路由未锁定高相关指南，检索结果相关性存疑"] : []),
        ...(errors.map((e) => `⚠️ ${e}`)),
        "",
        "─ 相关指南 ─",
        ...(guides.length ? guides.map((g, i) => `  ${i + 1}. ${g.title} (score=${g.score}${g.department ? `, ${g.department}` : ""})`) : ["  （无匹配指南）"]),
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
        detectedDept,
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
