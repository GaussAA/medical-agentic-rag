// query-sanitize.mjs
// 检索查询输入脱敏 —— 在查询进入向量库/BM25 检索与 telemetry 埋点前，
// 强制剥离手机号/身份证/邮箱等 PII，避免患者敏感信息落入查询日志或检索上下文。
// 纯 .mjs，双可测（jiti + 原生 node）。

import { maskPII } from "./phi-crypto.mjs";

/**
 * 对检索查询做安全净化：脱敏 PII + 去空白 + 兜底空串。
 * 医疗领域词（如「患者65岁」「血压120」）不被误伤（maskPII 仅匹配高置信 PII 模式）。
 * @param {unknown} q 原始查询（可能来自 LLM 参数，类型不定）
 * @returns {string} 已脱敏的查询串
 */
export function sanitizeSearchQuery(q) {
  if (q == null) return "";
  const s = String(q).trim();
  if (!s) return "";
  return maskPII(s);
}

/** 对自由文本（如 telemetry、日志）做同样的 PII 脱敏后返回。 */
export function sanitizeForLog(text) {
  if (text == null) return text;
  return maskPII(String(text));
}
