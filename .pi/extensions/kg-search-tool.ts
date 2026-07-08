import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 医疗知识图谱搜索工具
 *
 * 注册 kg_search 工具，让 Agent 在回答时可查询疾病-药物-症状关系。
 * 数据来源: medical-knowlegde-base/.knowledge-graph.json（由 extract-entities.mjs 生成）
 */
export default function (pi: ExtensionAPI) {
  let graph: any[] = [];
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const graphPath = join(process.cwd(), "medical-knowlegde-base", ".knowledge-graph.json");
      const data = JSON.parse(await readFile(graphPath, "utf-8"));
      graph = data.entities || [];
      loaded = true;
    } catch {
      graph = [];
      loaded = true;
    }
  }

  pi.registerTool({
    name: "kg_search",
    description: "搜索医学知识图谱，查找疾病、药物、症状、检查之间的关联关系。当需要了解某疾病的相关信息时使用。",
    promptSnippet: "Search medical knowledge graph for disease-drug-symptom relationships",
    parameters: {
      type: "object",
      properties: {
        disease: {
          type: "string",
          description: "疾病名称（支持模糊匹配）",
        },
        entityType: {
          type: "string",
          enum: ["drug", "symptom", "examination", "riskFactor", "treatment", ""],
          description: "筛选实体类型：药物/症状/检查/危险因素/治疗",
        },
        relation: {
          type: "string",
          enum: ["treated_with", "has_symptom", "diagnosed_by", "has_risk", "treated_by", ""],
          description: "筛选关系类型",
        },
      },
      required: [],
    },
    execute: async (params: { disease?: string; entityType?: string; relation?: string }) => {
      await ensureLoaded();

      if (graph.length === 0) {
        return { content: [{ type: "text", text: "知识图谱尚未生成，请先运行 scripts/extract-entities.mjs" }] };
      }

      let results = [...graph];

      // Filter by disease name (fuzzy match)
      if (params.disease) {
        const kw = params.disease.toLowerCase();
        results = results.filter(
          (e) =>
            (e.disease || "").toLowerCase().includes(kw),
        );
      }

      // Filter by entity type
      if (params.entityType) {
        results = results.filter((e) => e.entityType === params.entityType);
      }

      // Filter by relation
      if (params.relation) {
        results = results.filter((e) => e.relation === params.relation);
      }

      // Deduplicate and limit
      const seen = new Set();
      const deduped = [];
      for (const r of results) {
        const key = `${r.disease}|${r.entityName}|${r.entityType}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push(r);
          if (deduped.length >= 30) break;
        }
      }

      if (deduped.length === 0) {
        return { content: [{ type: "text", text: `未找到与"${params.disease || ""}"相关的知识图谱条目。` }] };
      }

      // Group by disease for display
      const grouped: Record<string, any[]> = {};
      for (const r of deduped) {
        const disease = r.disease || "未知";
        if (!grouped[disease]) grouped[disease] = [];
        grouped[disease].push(r);
      }

      let output = `知识图谱查询结果（${deduped.length} 条）:\n\n`;
      for (const [disease, items] of Object.entries(grouped)) {
        output += `【${disease}】\n`;
        const byType: Record<string, string[]> = {};
        for (const item of items) {
          const type = item.entityType || "other";
          if (!byType[type]) byType[type] = [];
          byType[type].push(item.entityName);
        }
        for (const [type, names] of Object.entries(byType)) {
          const label = { drug: "药物", symptom: "症状", examination: "检查", riskFactor: "危险因素", treatment: "治疗" }[type] || type;
          output += `  ${label}: ${[...new Set(names)].join("、")}\n`;
        }
        output += `  来源: ${items[0].source || "未知"}\n\n`;
      }

      return { content: [{ type: "text", text: output }] };
    },
  });
}
