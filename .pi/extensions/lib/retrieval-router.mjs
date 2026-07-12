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

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { diag } from "./diagnostic-log.mjs";
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
 * @returns {string|null} 知识库 DB 文件的绝对路径，或 null
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

/**
 * 测试用：注入自定义 DB 连接或路径（切换时互清，避免残留连接导致错库）。
 * @param {object|string|null} dbOrPath  better-sqlite3 连接实例、DB 路径、或 null（重置）
 */
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

/**
 * 获取只读 DB 连接（懒加载、缓存）。
 * @returns {object|null} better-sqlite3 连接实例，或 null
 */
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
 * @param {object} db  better-sqlite3 连接实例
 * @returns {string[]} 不重复的 file_path 数组
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
 * @param {string} content  chunk 原始内容
 * @param {string[]} qTok  查询词元数组
 * @param {number} [len=240]  摘要最大长度
 * @returns {string} 含上下文片段的摘要
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

// ---------------------------------------------------------------------------
// FTS5 trigram 中文候选召回
//
// 修复：pi-knowledge 既有 chunks_fts 用默认 unicode61 分词器，中文无空格 → MATCH 全失效；
// 迫使 retrieval-router 对 chunks 全表扫描后再 JS 端 BM25（随 chunks 线性退化：44万→~18s）。
// 本库自建**独立** FTS5 trigram 虚拟表（不触碰 pi-knowledge 内部库，重建安全），
// 索引 chunks 原始 content；trigram 对 3+ 字中文短语子串匹配完美，2 字及以下自然降级全扫。
// 惰性构建 + 失效检测（chunks 行数 + MAX(indexed_at)），零新增依赖。
// ---------------------------------------------------------------------------

/** 独立 FTS 库路径（与 retrieval-cache 同处 .pi/cache，隔离 pi-knowledge 内部库）。 */
export function ftsDbPath() {
  return join(process.cwd(), ".pi", "cache", "retrieval-fts.db");
}

let _ftsDb = null;
let _ftsSig = null;
let _ftsPathOverride = null;

/** 测试/运维钩子：覆盖 FTS 库路径（同时清空已缓存连接）。 */
export function setFtsDbPath(p) {
  _ftsPathOverride = p;
  resetFtsDb();
}
/** 测试钩子：清空模块级 FTS 连接缓存。 */
export function resetFtsDb() {
  if (_ftsDb) {
    try {
      _ftsDb.close();
    } catch {}
  }
  _ftsDb = null;
  _ftsSig = null;
}

/**
 * 候选 IN 上限：超过则收窄收益甚微且逼近 SQLite 单次语句参数上限(999)，
 * 此时放弃 IN 约束、降级为全表扫描（对 4413 级语料仍仅 ~180ms）。
 */
const MAX_FTS_CANDIDATES = 800;

/**
 * 从查询抽取可用于 trigram 召回的词元：CJK 按 ≥3 字滑窗（覆盖无空格中文短语重叠），
 * 拉丁/数字按 ≥3 字词元。2 字及以下中文无法构成 trigram → 丢弃（自然降级全扫）。
 * @param {string} query
 * @returns {string[]} 去重后的 3+ 字词元
 */
export function ftsQueryTokens(query) {
  const n = normalize(query);
  if (!n) return [];
  const tokens = [];
  for (const w of n.match(/[一-鿿]+/g) || []) {
    if (w.length < 3) continue;
    for (let i = 0; i + 3 <= w.length; i++) tokens.push(w.slice(i, i + 3));
  }
  for (const m of n.match(/[a-z0-9]+/g) || []) {
    if (m.length >= 3) tokens.push(m);
  }
  return [...new Set(tokens)];
}

/**
 * 用 FTS5 trigram 召回与查询相关的 chunk_id 候选集（逐词 MATCH 后取并集，BM25 后再排序）。
 * @param {object} ftsDb  FTS 库连接
 * @param {string} query
 * @returns {string[]|null} chunk_id 列表；null 表示无 3+ 字词元或 FTS 异常（应降级全扫）
 */
export function ftsCandidateIds(ftsDb, query) {
  const tokens = ftsQueryTokens(query);
  if (tokens.length === 0) return null;
  const seen = new Set();
  const out = [];
  try {
    const stmt = ftsDb.prepare("SELECT chunk_id FROM chunks_fts WHERE content MATCH ?");
    for (const t of tokens) {
      const rows = stmt.all(`"${t.replace(/"/g, '""')}"`);
      for (const r of rows) if (!seen.has(r.chunk_id)) { seen.add(r.chunk_id); out.push(r.chunk_id); }
    }
  } catch (e) {
    diag.error("retrieval-router", "FTS 查询异常，降级全扫: " + e.message);
    return null;
  }
  return out;
}

/**
 * 从源 DB 重建 FTS5 trigram 索引到 ftsDb（覆盖式，事务批量插入）。
 * 以 chunks 暗藏整数 rowid 作为 FTS rowid，chunk_id 等元数据以 UNINDEXED 列随行携带。
 * 同时预建**全局 df 表**（token → 文档频率）与 meta.total（语料总 chunk 数），
 * 供 FTS 模式下 BM25 使用「全局 IDF」打分，排名与全扫严格一致（杜绝子集 IDF 漂移）。
 * @param {object} srcDb  knowledge.db 只读连接
 * @param {object} ftsDb  目标 FTS 库连接（readwrite）
 * @param {string} sig    源签名（chunks 行数:MAX(indexed_at):内容总长），写入 meta 供失效检测
 */
export function buildFtsIndex(srcDb, ftsDb, sig) {
  ftsDb.exec("DROP TABLE IF EXISTS chunks_fts");
  ftsDb.exec("DROP TABLE IF EXISTS meta");
  ftsDb.exec("DROP TABLE IF EXISTS df");
  ftsDb.exec(
    "CREATE VIRTUAL TABLE chunks_fts USING fts5(content, chunk_id UNINDEXED, file_path UNINDEXED, kb_id UNINDEXED, tokenize='trigram')",
  );
  ftsDb.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
  // 全局文档频率表：与 BM25 所用 tokenize 同源，保证 IDF 与全扫完全一致
  ftsDb.exec("CREATE TABLE df (token TEXT PRIMARY KEY, df INTEGER NOT NULL)");
  const insFts = ftsDb.prepare(
    "INSERT INTO chunks_fts(rowid, content, chunk_id, file_path, kb_id) VALUES (?, ?, ?, ?, ?)",
  );
  const insMeta = ftsDb.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)");
  const insDf = ftsDb.prepare("INSERT OR REPLACE INTO df(token, df) VALUES (?, ?)");
  const total = srcDb.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const tx = ftsDb.transaction(() => {
    const rows = srcDb
      .prepare("SELECT rowid, id, content, file_path, kb_id FROM chunks")
      .all();
    const dfMap = new Map(); // token -> 文档频率（每 chunk 内去重计 1）
    for (const r of rows) {
      insFts.run(r.rowid, r.content || "", r.id, r.file_path || "", r.kb_id || "");
      for (const tk of new Set(tokenize(r.content || ""))) {
        dfMap.set(tk, (dfMap.get(tk) || 0) + 1);
      }
    }
    for (const [tk, d] of dfMap) insDf.run(tk, d);
    insMeta.run("sig", sig);
    insMeta.run("total", String(total));
  });
  tx();
}

/** 计算源库签名：chunks 行数 + MAX(indexed_at) + 内容总长指纹，任一变化即判定需重建。 */
export function sourceSig(srcDb) {
  const row = srcDb
    .prepare(
      "SELECT COUNT(*) n, COALESCE(MAX(indexed_at), 0) mx, COALESCE(SUM(length(content)), 0) cl FROM chunks",
    )
    .get();
  return `${row.n}:${row.mx}:${row.cl}`;
}

/**
 * 确保 FTS 索引就绪（惰性构建 + 失效重建），返回 FTS 库连接。
 * 运行期（getFtsDb）与运维预构建脚本共用。内存库（":memory:"）跳过，降级全扫。
 * @param {object} srcDb  knowledge.db 只读连接
 * @param {string} [ftsPathOverride]  覆盖 FTS 库路径（测试/独立实例）
 * @returns {object|null} FTS 库连接，或 null（源库不可用/构建失败）
 */
export function ensureFtsIndex(srcDb, ftsPathOverride) {
  if (!srcDb) return null;
  let isMemory = false;
  try {
    isMemory = srcDb.name === ":memory:";
  } catch (e) {
    diag.info("retrieval-router", "srcDb.name 读取失败，保守按非内存库处理: " + (e?.message || e));
  }
  if (isMemory) return null; // 内存库不建持久 FTS（测试场景），降级全扫

  const ftsPath = ftsPathOverride || _ftsPathOverride || ftsDbPath();
  let sig;
  try {
    sig = sourceSig(srcDb);
  } catch (e) {
    diag.error("retrieval-router", "源库签名计算失败，降级全扫: " + (e?.message || e));
    return null;
  }
  const usingDefault = !ftsPathOverride && !_ftsPathOverride;
  if (usingDefault && _ftsDb && _ftsSig === sig) return _ftsDb;

  let db;
  try {
    mkdirSync(dirname(ftsPath), { recursive: true });
    db = new Database(ftsPath);
  } catch (e) {
    diag.error("retrieval-router", "无法打开 FTS 库: " + e.message);
    return null;
  }
  let needBuild = true;
  try {
    const m = db.prepare("SELECT v FROM meta WHERE k='sig' LIMIT 1").get();
    if (m && m.v === sig) needBuild = false;
  } catch (e) {
    diag.info("retrieval-router", "meta 读取失败，强制重建: " + (e?.message || e));
    needBuild = true;
  }
  if (needBuild) {
    try {
      buildFtsIndex(srcDb, db, sig);
    } catch (e) {
      diag.error("retrieval-router", "FTS 构建失败，降级全扫: " + e.message);
      try {
        db.close();
      } catch (e2) {
        diag.info("retrieval-router", "FTS 库关闭失败(可忽略): " + (e2?.message || e2));
      }
      try {
        unlinkSync(ftsPath);
      } catch (e2) {
        diag.info("retrieval-router", "FTS 文件删除失败(可忽略): " + (e2?.message || e2));
      }
      return null;
    }
  }
  if (usingDefault) {
    _ftsDb = db;
    _ftsSig = sig;
  }
  return db;
}

/** 运行期入口：复用模块级缓存的 FTS 连接（惰性构建 + 失效重建）。 */
export function getFtsDb(srcDb) {
  return ensureFtsIndex(srcDb);
}

/**
 * 纯函数：在候选 chunks 上做 BM25 风格排序。
 * 词元化复用 guide-router 的 tokenize（CJK 单字+二元组、拉丁词、同义词扩展），与路由同源。
 * IDF 在当前候选集上计算。候选集优先由 FTS5 trigram 中文召回收窄（详见编排注释）。
 *
 * @param {object} db  better-sqlite3 连接实例
 * @param {string} query  原始查询
 * @param {object} [opts] { limit, kbFiles, kbId, ftsDb }
 * @returns {Array} 排序后的 {file_path,score,snippet,metadata}
 */
export function lexicalSearch(db, query, opts = {}) {
  const { limit = 8, kbFiles = null, kbId = null, ftsDb = null } = opts;
  const qNorm = normalize(query);
  if (!qNorm) return [];

  const qTok = tokenize(query);
  if (qTok.size === 0) return [];

  // 1) 候选集：优先用 FTS5 trigram 中文召回收窄（全语料场景收益最大；2 字词/异常则降级全扫）
  let candidateIds = null;
  // ftsDb===false 表示显式禁用 FTS（强制全扫，用于对照/回退比较；生产路径不传）
  const fdb = opts.ftsDb === false ? null : ftsDb || getFtsDb(db);
  if (fdb) {
    const ids = ftsCandidateIds(fdb, query);
    if (ids && ids.length && ids.length <= MAX_FTS_CANDIDATES) candidateIds = ids;
  }

  // 2) 组装 SQL：FTS 候选约束 + kb_id + 路由文件名约束（三者取交集，互不冲突）
  let sql = "SELECT id, file_path, content, metadata_json FROM chunks WHERE 1=1";
  const params = [];
  if (candidateIds) {
    const ph = candidateIds.map(() => "?").join(",");
    sql += ` AND id IN (${ph})`;
    params.push(...candidateIds);
  }
  if (kbId) {
    const realKb = resolveKbId(db, kbId);
    if (realKb) {
      sql += " AND kb_id = ?";
      params.push(realKb);
    }
    // realKb 为 null（传入未知名字/UUID）→ 不追加过滤，避免 0 行退化
  }
  if (kbFiles && kbFiles.length) {
    const ph = kbFiles.map(() => "?").join(",");
    sql += ` AND file_path IN (${ph})`;
    params.push(...kbFiles);
  }
  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) return [];

  // 3) IDF：FTS 模式用**全局** IDF（构建期预存的 df 表 + meta.total），与全扫排名严格一致，
  //    杜绝「候选子集 IDF」导致的排名漂移；全扫/降级模式则在候选集(=全语料)上计算（原行为）。
  let N;
  let df;
  if (candidateIds && fdb) {
    N = Number(fdb.prepare("SELECT v FROM meta WHERE k='total'").get().v);
    df = new Map();
    const getDf = fdb.prepare("SELECT df FROM df WHERE token = ?");
    for (const qt of qTok) {
      const r = getDf.get(qt);
      if (r) df.set(qt, r.df);
    }
  } else {
    N = rows.length;
    df = new Map();
    for (const r of rows) {
      for (const tk of new Set(tokenize(r.content || ""))) df.set(tk, (df.get(tk) || 0) + 1);
    }
  }
  const idf = (t) => Math.log(N / Math.max(1, df.get(t) || 0));

  // 4) 逐 chunk 打分（仅对候选 chunks tokenize，规模已收敛）
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
  // 同分稳定排序：分数 → 命中词元数 → 文件名（消除 SQLite 任意行序导致的结果抖动）
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      b.hitCount - a.hitCount ||
      (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0),
  );

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
