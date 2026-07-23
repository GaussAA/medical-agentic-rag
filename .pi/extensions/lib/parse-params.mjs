/**
 * parse-params.mjs — Pi 扩展参数归一化
 * ==========================================
 * Pi 框架向扩展工具 `execute` 传入的 params 有 3 种变体格式：
 *   1) 直接对象            → { query: "..." }
 *   2) JSON 字符串          → '{"query": "..."}'
 *   3) 嵌套 {arguments}    → { arguments: '{"query": "..."}' }
 *
 * 本模块提供单一归一化入口，消除各扩展中的重复解析逻辑。
 *
 * @module parse-params
 */

/**
 * 将 Pi 框架的变体参数归一化为标准对象
 * @param {any} params — Pi 框架传入的原始参数
 * @returns {object} 归一化后的参数对象，解析失败时返回空对象
 */
export function normalizeParams(params) {
  let p = params;
  if (typeof p === "string") {
    try {
      p = JSON.parse(p);
    } catch {
      /* 保持原样 */
    }
  }
  if (p && typeof p === "object" && typeof p.arguments === "string") {
    try {
      p = JSON.parse(p.arguments);
    } catch {
      /* 保持原样 */
    }
  } else if (p && typeof p === "object" && typeof p.arguments === "object") {
    p = p.arguments;
  }
  return (p && typeof p === "object" && !Array.isArray(p)) ? p : {};
}
