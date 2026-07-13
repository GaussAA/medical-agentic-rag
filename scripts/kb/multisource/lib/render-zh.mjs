// scripts/kb/multisource/lib/render-zh.mjs
//
// 把英文 OA 全文渲染为中文可检索条目（解本库中文-centric 检索约束）：
//   - 中文标题（来自 gap spec 的病种名）
//   - 「中文检索锚点」段：写入中文同义词，使 BM25 / 路由能命中中文查询
//   - 保留英文原文供核验（fidelity，不杜撰）
//   - 明确标注「开放获取英文指南·结构化摘引」，临床以官方指南为准
//
// 诚信红线：不冒充原文、不生成占位正文；锚点仅为检索入口，原文链接留存溯源块。

import { normalizeDoc, truncateSafe } from "./normalize.mjs";

/**
 * @param {object} args
 * @param {string} args.enText 英文全文（已抽文本）
 * @param {object} args.gap 缺口规格 { disease, keywords[], department }
 * @param {object} args.sourceMeta { name, short, license, url, year, openAccess }
 * @returns {string} 规范化可入库文本
 */
export function renderZhEntry({ enText, gap, sourceMeta }) {
  const disease = gap.disease || "未知病种";
  const kwLine = (gap.keywords || []).join("；");
  const title = `${disease}诊治指南（${sourceMeta.short}·开放获取英文指南·中文结构化摘引）`;

  const anchor = [
    `## 中文检索锚点`,
    ``,
    `本病种中文名：${disease}。相关中文术语与同义词：${kwLine}。`,
    ``,
    `> 说明：本条目由开放获取（Open Access）英文指南经「结构化摘引」生成——中文标题与关键词仅为检索锚点，`,
    `> 正文保留英文原文以供核验；临床决策请以最新官方指南与原文为准。原始链接见文首溯源块。`,
  ].join("\n");

  const body = truncateSafe(`${anchor}\n\n${enText}`, 500_000);
  return normalizeDoc(body, {
    title,
    source: sourceMeta.name,
    license: sourceMeta.license || (sourceMeta.openAccess ? "开放获取(OA)" : "未知"),
    url: sourceMeta.url,
    year: sourceMeta.year,
  });
}
