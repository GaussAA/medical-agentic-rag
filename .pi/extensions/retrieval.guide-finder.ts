import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { routeGuides, loadIndex } from "./lib/guide-router.mjs";

/**
 * 指南查找工具 - 层级检索增强（语义路由版）
 *
 * 根据用户问题，先定位应查询哪份(或多份)指南，然后定向搜索，提高检索精度。
 * 路由逻辑已抽取至 ./lib/guide-router.mjs（纯函数 + 文件化缓存），本文件仅作工具封装。
 *
 * 数据来源: knowledge-base/.guide-index.json
 */
export default function (pi: ExtensionAPI) {
  let index: any = null;
  let loaded = false;

  async function ensureLoaded() {
    if (loaded) return;
    try {
      index = loadIndex();
      loaded = true;
    } catch {
      index = { guideMap: {}, keywordIndex: {} };
      loaded = true;
    }
  }

  pi.registerTool({
    name: "guide_finder",
    description:
      "查找与疾病或症状相关的医疗指南。在调用 rag_search 前使用本工具，" +
      "可确定应查询哪份(或多份)指南。支持语义路由（同义/模糊匹配）。",
    promptSnippet: "Find which medical guideline(s) are relevant to a disease or symptom, with semantic routing",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "疾病名称、症状、药物或检查名称",
        },
        useSemantic: {
          type: "boolean",
          description: "是否启用语义路由（同义/模糊匹配），默认 true。设为 false 仅做关键词/标题字面匹配。",
        },
      },
      required: ["query"],
    },
    execute: async (_toolCallId: string, params: any) => {
      await ensureLoaded();
      // 鲁棒解析：Pi 框架可能把参数传为 (a) 直接对象 (b) JSON 字符串 (c) 嵌套 {arguments}
      // 此前因 params.query 未被正确绑定 → 误走"空查询"分支，语义路由整轮失效。
      let p = params;
      if (typeof p === "string") { try { p = JSON.parse(p); } catch { /* 保持原样 */ } }
      if (p && typeof p === "object" && typeof p.arguments === "string") {
        try { p = JSON.parse(p.arguments); } catch { /* 保持原样 */ }
      } else if (p && typeof p === "object" && typeof p.arguments === "object") {
        p = p.arguments;
      }
      const query = ((p && p.query) || "").toString().trim();
      if (!query) {
        return { content: [{ type: "text", text: "请提供查询关键词。" }] };
      }

      const useSemantic = params.useSemantic !== false;
      const { top, totalMatched, semantic, cached } = routeGuides(query, { index, useSemantic });

      if (totalMatched === 0) {
        return {
          content: [{
            type: "text",
            text: `未找到与"${query}"直接相关的指南。建议直接使用 rag_search 进行全文搜索。`,
          }],
        };
      }

      const lines = [
        `与"${query}"相关的指南 (${top.length}份，语义路由:${semantic ? "开" : "关"}，缓存:${cached ? "命中" : "未命中"}):\n`,
      ];
      for (const g of top) {
        lines.push(`  ${g.title}  (score=${g.score})`);
        lines.push(`    疾病: ${g.disease}`);
        if (g.sectionCount != null) lines.push(`    章节数: ${g.sectionCount}`);
        if (g.reasons && g.reasons.length) lines.push(`    命中依据: ${g.reasons.join("；")}`);
      }

      lines.push(`\n建议: 使用 rag_search 时指定 kb_id: "医疗指南" 进行定向搜索。`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
