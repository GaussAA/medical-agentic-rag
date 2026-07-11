// retrieval-router.mjs
// 定向召回纯函数库：将 guide_finder 的语义路由结果"翻译"为知识库检索约束，
// 避免真指南被无关文档压沉（原始会话卡死的根因之一）。
//
// 设计约束（来自 Pi 扩展架构现实）：
//   1) pi-knowledge 仅导出 default 扩展函数，engine 私有，外部无法直连 engine.search；
//   2) jiti 每扩展独立实例化 → 二次 import pi-knowledge 会触发第二次重型初始化（加载 e5 模型，分钟级卡死）；
//   3) ExtensionAPI 不提供运行期调用其他工具的接口。
// 故本库**完全自包含**：直接读 pi-knowledge 的 SQLite（chunks 表 + chunks_fts 快照），
// 用语义路由锁定指南文件名 → 约束到该指南 chunks → JS 端 BM25 排序。语料极小（数百~数千 chunk），
// 瞬时完成，零 Pi 运行时耦合，无二次 init。
//
// 纯 JavaScript（.mjs），无 TS 语法：供 knowledge-search-router.ts（jiti）与 tests（原生 node）共用。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { normalize, tokenize, routeGuides, loadIndex } from "./guide-router.mjs";
import { cacheGet, cacheSet } from "./retrieval-cache.mjs";

const require = createRequire(import.meta.url);

/**
 * 动态加载 better-sqlite3。
 * 该原生模块随 pi-knowledge 安装于 pi 的 npm 根（如 C:/Users/JaNiy/.pi/agent/npm/node_modules），
 * 项目自身 node_modules 未必有；故按候选绝对路径兜底（CJS require 目录解析天然可用），
 * 兼容 jiti 扩展运行期与原生 node 测试。
 */
function loadBetterSqlite3() {
  const candidates = [
    "better-sqlite3",
    process.env.PI_AGENT_NPM && join(process.env.PI_AGENT_NPM, "node_modules", "better-sqlite3"),
    "C:/Users/JaNiy/.pi/agent/npm/node_modules/better-sqlite3",
    join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules", "better-sqlite3"),
  ].filter(Boolean);
  let lastErr;
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (mod) return mod.default || mod;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("better-sqlite3 不可用（pi-knowledge 未安装？）：" + (lastErr?.message || ""));
}

const Database = loadBetterSqlite3();

/**
 * 解析 pi-knowledge 的 SQLite 路径。
 * 优先级：环境变量 PI_KNOWLEDGE_DIR → 已知默认 (~/.pi/knowledge) → 失败返回 null。
 */
export function resolveKbDbPath() {
  const env = process.env.PI_KNOWLEDGE_DIR || process.env.PICODING_KNOWLEDGE_DIR;
  if (env) return join(env, "knowledge.db");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) return join(home, ".pi", "knowledge", "knowledge.db");
  return null;
}

// 模块级 DB 连接（运行期复用，只读）。测试可通过 setDb 注入。
let _db = null;
let _dbPathOverride = null;

/** 测试用：注入自定义 DB 连接或路径（切换时互清，避免残留连接导致错库）。 */
export function setKbDb(dbOrPath) {
  if (dbOrPath == null) {
    _db = null;
    _dbPathOverride = null;
    return;
  }
  if (typeof dbOrPath === "string") {
    _dbPathOverride = dbOrPath;
    _db = null;
  } else {
    _db = dbOrPath;
    _dbPathOverride = null;
  }
}

/** 获取只读 DB 连接（懒加载、缓存）。 */
export function getDb() {
  if (_db) return _db;
  const p = _dbPathOverride || resolveKbDbPath();
  if (!p || !existsSync(p)) return null;
  _db = new Database(p, { readonly: true, fileMustExist: true });
  return _db;
}

/**
 * 读取 KB 中所有不同的 file_path（即被索引的 .md / 源文件名）。
 * 这是"路由标题 → 实际文件名"匹配的候选全集。
 */
export function loadKbFilenames(db) {
  const rows = db
    .prepare("SELECT DISTINCT file_path FROM chunks WHERE file_path IS NOT NULL AND file_path <> ''")
    .all();
  return rows.map((r) => r.file_path);
}

/**
 * 纯函数：将语义路由得到的指南标题，映射到 KB 中实际存在的文件名。
 * 匹配策略（由松到紧）：
 *   ① 标题 + ".md" / 标题本身完全相等；
 *   ② 标题去 .md 后缀 + ".md" 相等；
 *   ③ 双向子串包含（兼容文件名截断 / 标点上细微差异）。
 * @param {string[]} routedTitles  routeGuides().top 的标题列表
 * @param {string[]} kbFilenames    KB 中实际存在的 file_path 全集
 * @returns {string[]} 命中的 KB 文件名（去重、保序）
 */
export function resolveKbFiles(routedTitles, kbFilenames) {
  const out = [];
  const seen = new Set();
  for (const t of routedTitles || []) {
    const base = String(t || "").replace(/\.md$/i, "");
    let hit = kbFilenames.find((f) => f === base + ".md" || f === t);
    if (!hit) hit = kbFilenames.find((f) => f === base);
    if (!hit)
      hit = kbFilenames.find(
        (f) => f.includes(base) || base.includes(String(f).replace(/\.md$/i, "")),
      );
    if (hit && !seen.has(hit)) {
      seen.add(hit);
      out.push(hit);
    }
  }
  return out;
}

/**
 * 从 chunk 内容中抽取一段围绕首个命中词元的摘要。
 */
export function makeSnippet(content, qTok, len = 240) {
  const c = content || "";
  if (!c) return "";
  let pos = -1;
  const lower = c.toLowerCase();
  for (const t of qTok) {
    if (!t) continue;
    const i = lower.indexOf(String(t).toLowerCase());
    if (i >= 0 && (pos < 0 || i < pos)) pos = i;
  }
  if (pos < 0) return c.slice(0, len).replace(/\s+/g, " ").trim();
  const start = Math.max(0, pos - 60);
  const end = Math.min(c.length, start + len);
  return (
    (start > 0 ? "…" : "") +
    c.slice(start, end).replace(/\s+/g, " ").trim() +
    (end < c.length ? "…" : "")
  );
}

function safeJson(s) {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

/**
 * 将 LLM 传入的 kb_id（可能是内部 UUID，也可能是人类可读名如"医疗指南"）解析为
 * chunks.kb_id 列中真实存在的值。
 *   - 直接是真实 kb_id → 原样返回；
 *   - 是 knowledge_bases 的 id 或 name（大小写不敏感）→ 返回其 id；
 *   - 都不匹配（未知库）→ 返回 null，交由调用方跳过过滤，避免"名字不匹配→过滤 0 行→召回全空"退化。
 * 仅当返回非 null 时 lexicalSearch 才追加 `AND kb_id = ?` 过滤。
 */
function resolveKbId(db, kbId) {
  if (!kbId) return null;
  const direct = db.prepare("SELECT 1 FROM chunks WHERE kb_id = ? LIMIT 1").get(kbId);
  if (direct) return kbId;
  try {
    const row = db
      .prepare("SELECT id FROM knowledge_bases WHERE id = ? OR name = ? LIMIT 1")
      .get(kbId, kbId);
    if (row) return row.id;
  } catch {
    /* knowledge_bases 表不存在时忽略，走下面的 null 分支 */
  }
  return null;
}

/**
 * 纯函数：在候选 chunks 上做 BM25 风格排序。
 * 词元化复用 guide-router 的 tokenize（CJK 单字+二元组、拉丁词、同义词扩展），
 * 与路由同源 → 中英文混合查询的匹配一致。IDF 在当前候选集上计算。
 *
 * @param {Array} rows  chunk 行 [{id,file_path,content,metadata_json,...}]
 * @param {string} query  原始查询
 * @param {object} [opts] { limit, kbFiles }
 * @returns {Array} 排序后的 {file_path,score,snippet,metadata}
 */
export function lexicalSearch(db, query, opts = {}) {
  const { limit = 8, kbFiles = null, kbId = null } = opts;
  const qNorm = normalize(query);
  if (!qNorm) return [];

  // 1) 取候选集（可选：仅路由命中的指南文件）
  let sql = "SELECT id, file_path, content, metadata_json FROM chunks WHERE 1=1";
  const params = [];
  if (kbId) {
    const realKb = resolveKbId(db, kbId);
    if (realKb) {
      sql += " AND kb_id = ?";
      params.push(realKb);
    }
    // realKb 为 null（传入的是未知名字/UUID）→ 不追加过滤，避免 0 行退化
  }
  if (kbFiles && kbFiles.length) {
    const ph = kbFiles.map(() => "?").join(",");
    sql += ` AND file_path IN (${ph})`;
    params.push(...kbFiles);
  }
  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) return [];

  // 2) 词元与 IDF
  const qTok = tokenize(query);
  if (qTok.size === 0) return [];
  const N = Math.max(1, rows.length);
  const df = new Map();
  for (const r of rows) {
    for (const tk of new Set(tokenize(r.content || ""))) df.set(tk, (df.get(tk) || 0) + 1);
  }
  const idf = (t) => Math.log(N / Math.max(1, df.get(t) || 0));

  // 3) 逐 chunk 打分
  const scored = [];
  for (const r of rows) {
    const counts = new Map();
    for (const tk of tokenize(r.content || "")) counts.set(tk, (counts.get(tk) || 0) + 1);
    let score = 0;
    let hitCount = 0;
    for (const qt of qTok) {
      if (!df.has(qt)) continue; // OOV 词元对定位无贡献
      const tf = counts.get(qt) || 0;
      if (tf > 0) {
        score += (1 + idf(qt)) * tf;
        hitCount++;
      }
    }
    if (score > 0) scored.push({ file_path: r.file_path, score, hitCount, content: r.content, metadata: safeJson(r.metadata_json) });
  }
  scored.sort((a, b) => b.score - a.score);

  const qTokArr = [...qTok];
  return scored.slice(0, limit).map((r) => ({
    file_path: r.file_path,
    score: Number(r.score.toFixed(2)),
    hitCount: r.hitCount,
    snippet: makeSnippet(r.content || "", qTokArr),
    metadata: r.metadata,
  }));
}

/**
 * 高层编排：语义路由 → 约束文件名 → BM25 召回。
 * 若路由未在 KB 中命中任何文件，则退化为"全语料 BM25"（不约束），
 * 保证召回不丢失，仅失去精度增益（对未索引指南而言本就无更佳解）。
 *
 * @param {string} query
 * @param {object} [opts] { limit=8, kbId=null, useRouting=true, index=null, baseDir=null }
 * @returns {{results:Array, routedTitles:string[], kbFiles:string[], constrained:boolean, totalFiles:number, error?:string}}
 */
export function searchKnowledge(query, opts = {}) {
  const { limit = 8, kbId = null, useRouting = true, index = null, baseDir = null } = opts;
  const db = getDb();
  if (!db) {
    return { results: [], routedTitles: [], kbFiles: [], constrained: false, totalFiles: 0, error: "knowledge db unavailable" };
  }

  const kbFilesAll = loadKbFilenames(db);
  let kbFiles = null;
  let routedTitles = [];

  if (useRouting) {
    const idx = index || loadIndex(baseDir || undefined);
    const rr = routeGuides(query, { index: idx });
    routedTitles = rr.top.map((g) => g.title);
    kbFiles = resolveKbFiles(routedTitles, kbFilesAll);
  }

  const constrained = !!(kbFiles && kbFiles.length);
  // 约束时多取一些以便 BM25 在区间内充分排序；全语料时直接取 limit
  const fetchLimit = constrained ? Math.max(limit * 3, 20) : limit;
  const results = lexicalSearch(db, query, { limit: fetchLimit, kbFiles, kbId });

  return {
    results: results.slice(0, limit),
    routedTitles,
    kbFiles,
    constrained,
    totalFiles: kbFilesAll.length,
  };
}

export { Database };
