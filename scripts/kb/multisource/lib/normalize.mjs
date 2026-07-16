// scripts/kb/multisource/lib/normalize.mjs
import { isHeadingLine } from "../../../lib/chinese-heading.mjs"; // P1#5 统一中文层级标题判定
//
// 把 adapter 抓取的原始内容（HTML / JATS XML / 富文本）清洗为干净 UTF-8 纯文本，
// 并结构化为「# 标题」+ 中文层级标题，供 extract-outline.mjs 复用其中文层级正则。
// 文首嵌入溯源块（来源/许可/入库日期），便于 RAG 引证与合规审计。
//
// 纯函数为主（decodeEntities/stripTags/cleanWhitespace 可单测）；normalizeDoc 仅做轻量日期格式化。

const ENTITIES = {
  "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": "\"", "&apos;": "'",
  "&nbsp;": " ", "&ensp;": " ", "&emsp;": " ", "&hellip;": "…",
  "&ndash;": "–", "&mdash;": "—", "&lsquo;": "‘", "&rsquo;": "’",
  "&ldquo;": "“", "&rdquo;": "”", "&bull;": "•", "&middot;": "·",
  "&#160;": " ", "&#8217;": "’", "&#8216;": "‘", "&#8220;": "“", "&#8221;": "”",
  "&#8230;": "…", "&#8211;": "–", "&#8212;": "—",
};

export function decodeEntities(s) {
  let out = s;
  for (const [k, v] of Object.entries(ENTITIES)) out = out.split(k).join(v);
  // 数值实体 &#123; / &#x1F;（十进制/十六进制）
  out = out.replace(/&#x([0-9a-fA-F]+);/g, (_, h) => {
    try { return String.fromCodePoint(parseInt(h, 16)); } catch { return "?"; }
  });
  out = out.replace(/&#(\d+);/g, (_, d) => {
    try { return String.fromCodePoint(parseInt(d, 10)); } catch { return "?"; }
  });
  return out;
}

/** 剥除 HTML / 轻量 XML 标签，保留中文层级标题文字（一、二、（一）等不视为标签）。 */
export function stripTags(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<svg[\s\S]*?<\/svg>/gi, " ")
    .replace(/<table[\s\S]*?<\/table>/gi, " ") // 表格非检索重点，整体跳过
    .replace(/<(br|p|div|li|h[1-6]|tr|section|figcaption)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[\d+\]/g, " ") // 去参考文献角标 [1][2]
    .replace(/\{\{[^}]*\}\}/g, " "); // 去 wiki 模板残留
}

/** 折叠空白、去行首尾空格、合并空行。 */
export function cleanWhitespace(text) {
  return text
    .split("\n")
    .map((l) => l.replace(/[ \t\u00a0]+/g, " ").trim())
    .filter((l) => l.length > 0)
    .join("\n");
}

/**
 * 将清洗后的正文规范化为可入库文本。
 * @param {string} raw 抓取的原始内容（HTML/XML/纯文本皆可）
 * @param {object} meta { title, source, license, url, year?, department? }
 * @returns {string} 规范化 UTF-8 文本（含溯源块 + # 标题 + 正文）
 */
export function normalizeDoc(raw, meta = {}) {
  const title = (meta.title || "未命名指南").trim();
  let body = decodeEntities(String(raw || ""));
  body = stripTags(body);
  body = cleanWhitespace(body);

  // 若正文无中文层级标题（如纯论文段落），补一个「正文」分区，避免 outline 空结构
  // 判定统一走 scripts/lib/chinese-heading.mjs（isHeadingLine，含全角１．分支，修复原缺失漂移）
  const hasCnHeading = body.split(/\r?\n/).some(isHeadingLine);
  if (!hasCnHeading) {
    body = `## 正文\n\n${body}`;
  }

  const date = new Date().toISOString().slice(0, 10);
  const license = meta.license || "开放获取(来源声明)";
  const url = meta.url || "";
  const provenance = [
    `> 来源: ${meta.source || "未知"}`,
    `> 原始链接: ${url}`,
    `> 许可: ${license}`,
    `> 入库方式: 多源摄取骨架(开放许可优先)`,
    `> 入库日期: ${date}`,
  ].join("\n");

  return `# ${title}\n\n${provenance}\n\n${body}\n`;
}

/** 安全截断，避免超大文件触发引擎 oversized skip（>~10MB）。 */
export function truncateSafe(text, maxChars = 500_000) {
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n\n（内容过长已截断，详见原始链接）\n";
}
