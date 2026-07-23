// retrieval-router.mjs — 兼容入口
//
// 定向召回纯函数库。原单文件已按职责拆分为：
//   retrieval-router/db.mjs       — better-sqlite3 加载 + 连接管理
//   retrieval-router/matcher.mjs  — KB 文件名匹配 + 摘要
//   retrieval-router/fts.mjs      — FTS5 trigram 中文召回索引
//   retrieval-router/bm25.mjs     — BM25 排序 + searchKnowledge
//   retrieval-router/fusion.mjs   — RRF 结果融合

export { Database, resolveKbDbPath, setKbDb, getDb } from "./retrieval-router/db.mjs";
export { loadKbFilenames, resolveKbFiles, makeSnippet } from "./retrieval-router/matcher.mjs";
export { ftsDbPath, setFtsDbPath, resetFtsDb, ftsQueryTokens, ftsCandidateIds, buildFtsIndex, sourceSig, ensureFtsIndex, getFtsDb } from "./retrieval-router/fts.mjs";
export { lexicalSearch, searchKnowledge } from "./retrieval-router/bm25.mjs";
export { rrfFusion, weightedFusion } from "./retrieval-router/fusion.mjs";
