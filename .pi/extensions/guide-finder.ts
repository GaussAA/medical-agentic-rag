import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * 指南查找工具 - 层级检索增强
 *
 * 根据用户问题，先定位应查询哪份(或多份)指南，
 * 然后定向搜索，提高检索精度。
 *
 * 数据来源: medical-knowlegde-base/.guide-index.json
 */
export default function (pi: ExtensionAPI) {
  let index = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      const indexPath = join(process.cwd(), "medical-knowlegde-base", ".guide-index.json");
      index = JSON.parse(await readFile(indexPath, "utf-8"));
      loaded = true;
    } catch {
      index = { guideMap: {}, keywordIndex: {} };
      loaded = true;
    }
  }

  pi.registerTool({
    name: "guide_finder",
    description:
      "查找与疾病或症状相关的医疗指南。在调用 knowledge_search 前使用本工具，" +
      "可确定应查询哪份(或多份)指南。支持模糊匹配。",
    promptSnippet: "Find which medical guideline(s) are relevant to a disease or symptom",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "疾病名称、症状、药物或检查名称",
        },
      },
      required: ["query"],
    },
    execute: async (params) => {
      await ensureLoaded();
      const query = (params.query || "").trim().toLowerCase();
      if (!query) {
        return { content: [{ type: "text", text: "请提供查询关键词。" }] };
      }

      // Search keyword index (exact + contains)
      const matched = new Set();
      for (const [kw, guides] of Object.entries(index.keywordIndex)) {
        const kwLower = kw.toLowerCase();
        if (kwLower === query || kwLower.includes(query) || query.includes(kwLower)) {
          for (const g of guides) matched.add(g);
        }
      }

      // Also search guide titles directly
      for (const [title, info] of Object.entries(index.guideMap)) {
        const titleLower = title.toLowerCase();
        const disease = (info).disease.toLowerCase();
        if (titleLower.includes(query) || disease.includes(query)) {
          matched.add(title);
        }
      }

      if (matched.size === 0) {
        return {
          content: [{
            type: "text",
            text: `未找到与"${params.query}"直接相关的指南。建议直接使用 knowledge_search 进行全文搜索。`,
          }],
        };
      }

      // Sort by relevance (exact match first)
      const sorted = Array.from(matched).sort((a, b) => {
        const aExact = a.toLowerCase().includes(query) ? 0 : 1;
        const bExact = b.toLowerCase().includes(query) ? 0 : 1;
        return aExact - bExact;
      });

      const lines = [`与"${params.query}"相关的指南 (${sorted.length}份):\n`];
      for (const title of sorted) {
        const info = index.guideMap[title];
        lines.push(`  ${title}`);
        lines.push(`    疾病: ${info.disease}`);
        lines.push(`    章节数: ${info.sectionCount}`);
      }

      lines.push(`\n建议: 使用 knowledge_search 时指定 kb_id: "医疗指南" 进行定向搜索。`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
