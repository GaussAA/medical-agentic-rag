// guide-router.mjs — 兼容入口
//
// 指南路由纯函数库。原单文件已拆分为：
//   guide-router/vocab.mjs — 同义词表与停用词（数据）
//   guide-router/text.mjs  — 文本处理函数
//   guide-router/index.mjs — 指南索引管理
//   guide-router/route.mjs — 路由主逻辑

export { normalize, tokenize, applyPhraseAliases, extractYear, versionOf, lev } from "./guide-router/text.mjs";
export { loadIndex, buildIdf, buildGuideTokens } from "./guide-router/index.mjs";
export { routeGuides } from "./guide-router/route.mjs";
