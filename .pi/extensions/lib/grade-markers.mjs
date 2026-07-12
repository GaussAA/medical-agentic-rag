// grade-markers.mjs
// GRADE / 推荐强度标记词表（单一真相源，供 answer-eval-bench.mjs 与
// answer-quality-judge.mjs 共用，避免双脚本词表漂移）。
//
// 背景（T13 根因）：
//   原 GRADE_TOKENS 仅含英文 GRADE 体系原词（推荐意见/证据等级/强推荐/弱推荐/
//   Ⅰ-Ⅲ级/证据质量/推荐强度/高-低质量）。但卫健委中文指南多用「中文临床词汇」
//   表达推荐强度与证据质量（推荐/不推荐/建议/首选/一线/标准治疗/宜/不宜/应予/
//   避免/慎用/证据…），导致 gradeLabelRate 误判为「源文缺 GRADE 标记」。
//   实为「评测定义缺口」而非「知识层缺口」——指南本就携带丰富的推荐强度表述。
//
// 设计：
//   - GRADE_TOKENS        ：标准化 GRADE 原词（严格口径，用于 gradeStrict）
//   - REC_STRENGTH_TOKENS ：中文指南常见推荐强度/证据质量表述（补充口径）
//   - hasGradeMarker(text)：命中任一即视为该指南携带循证推荐标记（宽松口径，
//                          即 gradeLabelRate 实际度量值，贴合脚本头注释语义）
//   - hasStrictGrade(text)：仅命中标准化 GRADE 原词（观察用，非头条指标）

export const GRADE_TOKENS = [
  "推荐意见", "证据等级", "强推荐", "弱推荐",
  "Ⅰ级", "Ⅱ级", "Ⅲ级", "证据质量", "推荐强度",
  "高质量", "中等质量", "低质量",
];

// 中文指南推荐强度 / 证据质量表述（经 135 份卫健委指南语料校准）
export const REC_STRENGTH_TOKENS = [
  "推荐", "不推荐", "建议", "不建议",
  "首选", "一线", "标准治疗", "标准方案",
  "宜", "不宜", "应予", "应当", "必须",
  "避免", "慎用", "酌情", "考虑",
  "优选", "次选", "替代", "联合", "单用",
  "初始", "维持", "巩固", "挽救", "姑息", "最佳", "常规",
  "证据",
];

/**
 * 是否包含标准化 GRADE 原词（严格口径）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasStrictGrade(text) {
  return GRADE_TOKENS.some((t) => String(text).includes(t));
}

/**
 * 是否包含循证推荐标记（宽松口径：GRADE 原词 + 中文推荐强度表述）。
 * @param {string} text
 * @returns {boolean}
 */
export function hasGradeMarker(text) {
  return hasStrictGrade(text) || REC_STRENGTH_TOKENS.some((t) => String(text).includes(t));
}
