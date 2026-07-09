import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { searchKG, loadGraph } from "./lib/kg-search.mjs";

/**
 * 医疗知识图谱搜索工具
 *
 * 注册 kg_search 工具，让 Agent 在回答时可查询疾病-药物-症状关系。
 * 检索逻辑已抽取至 ./lib/kg-search.mjs（纯函数 + 文件化缓存），本文件仅作工具封装。
 * 数据来源: medical-knowlegde-base/.knowledge-graph.json（由 extract-entities.mjs 生成）
 */
export default function (pi: ExtensionAPI) {
  let graph: any[] = [];
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      graph = loadGraph();
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

      const res = searchKG(params, { graph });
      return { content: [{ type: "text", text: res.text }] };
    },
  });
}
