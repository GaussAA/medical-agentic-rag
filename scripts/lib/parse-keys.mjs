// scripts/lib/parse-keys.mjs
// 纯函数：将密钥 / 词表原始字符串（逗号 / 空白 / 换行分隔）解析为去空白、去空的数组。
//
// 单一真相源：scripts/kb/extract-entities.mjs 与 .pi/extensions/lib/llm-judge.mjs 原各持一份副本，
// 现收敛于此，消除漂移，并可独立单测（无模块级副作用，import 不触发任何管线）。
//
// 用法: import { parseKeys } from "../lib/parse-keys.mjs";

/**
 * 解析以逗号 / 空白 / 换行分隔的密钥或词表串。
 * @param {string|undefined|null} raw
 * @returns {string[]} 去空白、过滤空的字符串数组（raw 为空时返回 []）
 */
export function parseKeys(raw) {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}
