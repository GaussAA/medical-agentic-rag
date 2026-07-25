// kb-admin-server.mjs
// 知识库管理面板 —— 像 Qdrant Dashboard 一样交互式浏览、搜索、管理知识库分片。
//
// 启动: node scripts/admin/kb-admin-server.mjs [--port=3001]
// 访问: http://localhost:3001/
//
// 后端: 读取 ~/.pi/knowledge/knowledge.db + .pi/cache/chunk-meta.db（只读）
// 前端: 单页 HTML 应用（内嵌在服务中，零外部依赖）

import { createServer } from "node:http";
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
// 支持 PI_KNOWLEDGE_DIR 环境变量（项目级隔离），回退到用户 HOME
const KNOWLEDGE_DB = (() => {
  const dir = process.env.PI_KNOWLEDGE_DIR?.trim();
  if (dir) return join(dir, "knowledge.db");
  return join(HOME, ".pi", "knowledge", "knowledge.db");
})();
const META_DB = join(ROOT, ".pi", "cache", "chunk-meta.db");
const KB_DIR = join(ROOT, "data", "kb");
const INDEX_PATH = join(KB_DIR, ".guide-index.json");
// Wiki 知识库路径
const WIKI_META_DIR = join(ROOT, ".llm-wiki", "meta");
const WIKI_REGISTRY_PATH = join(WIKI_META_DIR, "registry.json");
const WIKI_PAGES_DIR = join(ROOT, ".llm-wiki", "wiki");

// 知识图谱路径
const KG_DB_PATH = join(KB_DIR, ".knowledge-graph.db");

let kgDb = null;

function getKgDb() {
  if (kgDb) return kgDb;
  if (!existsSync(KG_DB_PATH)) return null;
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    kgDb = new Database(KG_DB_PATH, { readonly: true });
    return kgDb;
  } catch { return null; }
}

const PORT = Number(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || 3001);

let db = null;
let metaDb = null;

function getDb() {
  if (db) return db;
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  db = new Database(KNOWLEDGE_DB, { readonly: true });
  return db;
}

function getMetaDb() {
  if (metaDb) return metaDb;
  if (!existsSync(META_DB)) return null;
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    metaDb = new Database(META_DB, { readonly: true });
    return metaDb;
  } catch { return null; }
}

function loadGuideIndex() {
  try {
    if (existsSync(INDEX_PATH)) return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch {}
  return null;
}

// ── HTTP 路由 ──

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

function sendJson(res, code, data) {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
}

function sendHtml(res, html) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

// ── API 处理 ──

function handleApi(url, res) {
  const d = getDb();

  // GET /api/stats — 知识库概览
  if (url.pathname === "/api/stats") {
    const total = d.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
    const files = d.prepare("SELECT COUNT(DISTINCT file_path) as c FROM chunks").get().c;
    const bytes = d.prepare("SELECT SUM(LENGTH(content)) as s FROM chunks").get().s || 0;

    const dist = d.prepare(`
      SELECT
        CASE
          WHEN LENGTH(content) < 100 THEN '<100'
          WHEN LENGTH(content) < 300 THEN '100-300'
          WHEN LENGTH(content) < 500 THEN '300-500'
          WHEN LENGTH(content) < 1000 THEN '500-1K'
          ELSE '>1K'
        END as bucket,
        COUNT(*) as cnt
      FROM chunks GROUP BY bucket ORDER BY MIN(LENGTH(content))
    `).all();

    // 分片最多的文件 TOP10
    const topFiles = d.prepare(`
      SELECT file_path, COUNT(*) as cnt, ROUND(AVG(LENGTH(content))) as avgLen
      FROM chunks GROUP BY file_path ORDER BY cnt DESC LIMIT 15
    `).all();

    // 文件类型分布
    const typeDist = d.prepare(`
      SELECT file_type, COUNT(*) as cnt FROM chunks GROUP BY file_type ORDER BY cnt DESC
    `).all();

    const gi = loadGuideIndex();
    const recallBl = (() => {
      try {
        const p = join(ROOT, "tests", "reports", "recall-baseline.json");
        if (existsSync(p)) return JSON.parse(readFileSync(p, "utf-8")).recall || 0;
      } catch {}
      return null;
    })();

    return sendJson(res, 200, {
      totalChunks: total,
      totalFiles: files,
      totalBytes: bytes,
      avgLength: total > 0 ? Math.round(bytes / total) : 0,
      lengthDist: dist,
      topFiles,
      typeDist,
      recallRate: recallBl,
      totalGuides: gi?.totalGuides || null,
    });
  }

  // GET /api/chunks?page=1&perPage=50&search=&file=&disease= — 分片列表
  if (url.pathname === "/api/chunks") {
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const perPage = Math.min(200, Math.max(10, Number(url.searchParams.get("perPage")) || 50));
    const search = (url.searchParams.get("search") || "").trim();
    const fileFilter = (url.searchParams.get("file") || "").trim();
    const diseaseFilter = (url.searchParams.get("disease") || "").trim();
    const metaOnly = url.searchParams.get("meta") === "1";

    const params = [];
    const wheres = [];

    if (search) { wheres.push("c.content LIKE ?"); params.push(`%${search}%`); }
    if (fileFilter) { wheres.push("c.file_path LIKE ?"); params.push(`%${fileFilter}%`); }
    if (metaOnly) { wheres.push("c.metadata_json != '{}'"); }

    const where = wheres.length > 0 ? "WHERE " + wheres.join(" AND ") : "";

    // 先查 disease 过滤（需要从 metaDb 取 chunk_id 列表）
    let diseaseIds = null;
    if (diseaseFilter) {
      const md = getMetaDb();
      if (md) {
        const rows = md.prepare("SELECT chunk_id FROM chunk_meta WHERE disease = ?").all(diseaseFilter);
        diseaseIds = new Set(rows.map(r => r.chunk_id));
      }
    }

    const total = d.prepare(`SELECT COUNT(*) as c FROM chunks c ${where}`).get(...params).c;

    let sql = `
      SELECT c.id, c.file_path, c.start_line, c.end_line, c.file_type,
             LENGTH(c.content) as clen, c.metadata_json,
             SUBSTR(c.content, 1, 200) as preview
      FROM chunks c
      ${where}
      ORDER BY c.file_path, c.start_line
      LIMIT ? OFFSET ?
    `;
    let sqlParams = [...params, perPage, (page - 1) * perPage];

    let rows = d.prepare(sql).all(...sqlParams);

    // 如果有 disease 过滤，在 JS 层过滤
    if (diseaseIds) {
      rows = rows.filter(r => diseaseIds.has(r.id));
    }

    // 批量查 meta
    const md = getMetaDb();
    const metaMap = new Map();
    if (md) {
      const ids = rows.map(r => r.id).filter(Boolean);
      if (ids.length > 0) {
        const ph = ids.map(() => "?").join(",");
        const metas = md.prepare(`SELECT chunk_id, disease, department, tags, is_deprecated FROM chunk_meta WHERE chunk_id IN (${ph})`).all(...ids);
        for (const m of metas) metaMap.set(m.chunk_id, m);
      }
    }

    const totalFiltered = diseaseIds ? rows.length : total;
    const totalPages = Math.ceil(totalFiltered / perPage);

    return sendJson(res, 200, {
      chunks: rows.map((r) => ({
        ...r,
        metadata: (() => { try { return JSON.parse(r.metadata_json || "{}"); } catch { return {}; } })(),
        ...(metaMap.get(r.id) || {}),
        tags: (() => { try { return JSON.parse((metaMap.get(r.id)?.tags) || "[]"); } catch { return []; } })(),
      })),
      page, perPage, total: totalFiltered, totalPages,
    });
  }

  // GET /api/chunks/:id — 分片详情
  const chunkDetailMatch = url.pathname.match(/^\/api\/chunks\/([a-f0-9-]+)$/);
  if (chunkDetailMatch) {
    const chunkId = chunkDetailMatch[1];
    const row = d.prepare(`SELECT * FROM chunks WHERE id = ?`).get(chunkId);
    if (!row) return sendJson(res, 404, { error: "chunk not found" });

    let extra = {};
    const md = getMetaDb();
    if (md) {
      const m = md.prepare("SELECT * FROM chunk_meta WHERE chunk_id = ?").get(chunkId);
      if (m) extra = { disease: m.disease, department: m.department, tags: m.tags, isDeprecated: m.is_deprecated };
    }

    return sendJson(res, 200, {
      ...row,
      ...extra,
      metadata: (() => { try { return JSON.parse(row.metadata_json || "{}"); } catch { return {}; } })(),
      tags: (() => { try { return JSON.parse(extra.tags || "[]"); } catch { return []; } })(),
      indexedAt: new Date(row.indexed_at).toISOString(),
    });
  }

  // GET /api/files — 文件列表
  if (url.pathname === "/api/files") {
    const rows = d.prepare(`
      SELECT file_path, COUNT(*) as chunkCount, SUM(LENGTH(content)) as totalBytes,
             MIN(start_line) as firstLine, MAX(end_line) as lastLine,
             ROUND(AVG(LENGTH(content))) as avgLen
      FROM chunks GROUP BY file_path ORDER BY chunkCount DESC
    `).all();
    return sendJson(res, 200, { files: rows });
  }

  // GET /api/diseases — 病种列表（有分片的病种）
  if (url.pathname === "/api/diseases") {
    const md = getMetaDb();
    if (!md) return sendJson(res, 200, { diseases: [] });
    const rows = md.prepare(`
      SELECT disease, COUNT(*) as chunkCount, COUNT(DISTINCT file_path) as fileCount
      FROM chunk_meta WHERE disease != '' GROUP BY disease ORDER BY chunkCount DESC
    `).all();
    return sendJson(res, 200, { diseases: rows });
  }

  // GET /api/guide-index — 指南索引
  if (url.pathname === "/api/guide-index") {
    const gi = loadGuideIndex();
    if (!gi) return sendJson(res, 404, { error: "guide-index not found" });
    return sendJson(res, 200, {
      totalGuides: gi.totalGuides,
      totalKeywords: gi.totalKeywords,
      guides: Object.entries(gi.guideMap || {}).map(([title, info]) => ({
        title, disease: info.disease, keywords: (info.keywords || []).slice(0, 10),
        deprecated: info.deprecated, version: info.version,
      })),
    });
  }

  // ── Wiki 知识库 API ──

  // GET /api/wiki/status — Wiki 概览
  if (url.pathname === "/api/wiki/status") {
    if (!existsSync(WIKI_REGISTRY_PATH)) return sendJson(res, 200, { available: false, total: 0 });
    const reg = JSON.parse(readFileSync(WIKI_REGISTRY_PATH, "utf-8"));
    const pages = Object.entries(reg.pages || {});
    const counts = { entity: 0, concept: 0, source: 0, analysis: 0, synthesis: 0 };
    for (const [, p] of pages) { if (counts[p.type] !== undefined) counts[p.type]++; }
    return sendJson(res, 200, {
      available: true,
      total: pages.length,
      version: reg.version || "N/A",
      lastUpdated: reg.last_updated || "N/A",
      ...counts,
    });
  }

  // GET /api/wiki/pages?type=&search=&page=1&perPage=50 — Wiki 页面列表
  if (url.pathname === "/api/wiki/pages") {
    if (!existsSync(WIKI_REGISTRY_PATH)) return sendJson(res, 200, { pages: [], total: 0 });
    const reg = JSON.parse(readFileSync(WIKI_REGISTRY_PATH, "utf-8"));
    const typeFilter = (url.searchParams.get("type") || "").trim();
    const searchQ = (url.searchParams.get("search") || "").trim().toLowerCase();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const perPage = Math.min(100, Math.max(10, Number(url.searchParams.get("perPage")) || 50));

    let entries = Object.entries(reg.pages || {});
    if (typeFilter) entries = entries.filter(([, p]) => p.type === typeFilter);
    if (searchQ) {
      entries = entries.filter(([slug, p]) =>
        slug.toLowerCase().includes(searchQ) ||
        (p.title || "").toLowerCase().includes(searchQ) ||
        (p.type || "").toLowerCase().includes(searchQ)
      );
    }

    const total = entries.length;
    const totalPages = Math.ceil(total / perPage);
    const slice = entries.slice((page - 1) * perPage, page * perPage);

    return sendJson(res, 200, {
      pages: slice.map(([slug, p]) => ({ slug, type: p.type, title: p.title || slug, created: p.created, updated: p.updated })),
      page, perPage, total, totalPages,
    });
  }

  // GET /api/wiki/page/:slug — 单个 Wiki 页面详情
  const wikiPageMatch = url.pathname.match(/^\/api\/wiki\/page\/(.+)$/);
  if (wikiPageMatch) {
    const slug = decodeURIComponent(wikiPageMatch[1]);
    let reg = null;
    if (existsSync(WIKI_REGISTRY_PATH)) reg = JSON.parse(readFileSync(WIKI_REGISTRY_PATH, "utf-8"));
    const meta = reg?.pages?.[slug] || null;

    // 尝试读取页面内容（.md 文件）
    let content = null;
    const mdPath = join(WIKI_PAGES_DIR, `${slug}.md`);
    if (existsSync(mdPath)) content = readFileSync(mdPath, "utf-8");

    return sendJson(res, 200, {
      slug,
      meta,
      content,
      exists: content !== null,
    });
  }

  // ── 知识图谱 API ──

  // GET /api/kg/stats — 图谱概览
  if (url.pathname === "/api/kg/stats") {
    const d = getKgDb();
    if (!d) return sendJson(res, 200, { available: false });
    const totalEdges = d.prepare("SELECT COUNT(*) as c FROM kg_edge").get().c;
    const totalSubjects = d.prepare("SELECT COUNT(DISTINCT subject) as c FROM kg_edge").get().c;
    const totalObjects = d.prepare("SELECT COUNT(DISTINCT object) as c FROM kg_edge").get().c;
    const predDist = d.prepare("SELECT predicate, COUNT(*) as cnt FROM kg_edge GROUP BY predicate ORDER BY cnt DESC").all();
    return sendJson(res, 200, {
      available: true,
      totalEdges, totalSubjects, totalObjects,
      predicateDistribution: predDist,
    });
  }

  // GET /api/kg/search?q=高血压 — 搜索实体
  if (url.pathname === "/api/kg/search") {
    const q = (url.searchParams.get("q") || "").trim();
    if (!q) return sendJson(res, 200, { results: [] });
    const d = getKgDb();
    if (!d) return sendJson(res, 200, { results: [] });
    const like = `%${q}%`;
    const rows = d.prepare(`
      SELECT DISTINCT subject as name FROM kg_edge WHERE subject LIKE ?
      UNION
      SELECT DISTINCT object as name FROM kg_edge WHERE object LIKE ?
      ORDER BY name LIMIT 50
    `).all(like, like);
    return sendJson(res, 200, { results: rows.map(r => r.name) });
  }

  // GET /api/kg/entity/:name — 实体详情
  const kgEntityMatch = url.pathname.match(/^\/api\/kg\/entity\/(.+)$/);
  if (kgEntityMatch) {
    let name;
    try { name = decodeURIComponent(kgEntityMatch[1]); } catch { return sendJson(res, 400, { error: "invalid entity name" }); }
    const d = getKgDb();
    if (!d) return sendJson(res, 200, { available: false });
    const outEdges = d.prepare("SELECT predicate, object, object_type, source FROM kg_edge WHERE subject = ?").all(name);
    const inEdges = d.prepare("SELECT subject, predicate, source FROM kg_edge WHERE object = ?").all(name);
    const relCount = outEdges.length + inEdges.length;
    return sendJson(res, 200, {
      name, relationCount: relCount,
      outEdges: outEdges.map(e => ({ relation: e.predicate, target: e.object, type: e.object_type, source: e.source })),
      inEdges: inEdges.map(e => ({ from: e.subject, relation: e.predicate, source: e.source })),
    });
  }

  return sendJson(res, 404, { error: "not found" });
}

// ── 内嵌 HTML 面板 ──

function servePanel(res) {
  const SPA_HTML = readFileSync(new URL("./kb-admin-panel.html", import.meta.url), "utf-8");
  sendHtml(res, SPA_HTML);
}

// ── 启动服务 ──

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname;

  if (path.startsWith("/api/")) {
    return handleApi(url, res);
  }

  // 单页面板
  if (path === "/" || path === "/index.html") {
    return servePanel(res);
  }

  sendJson(res, 404, { error: "not found" });
});

if (!existsSync(KNOWLEDGE_DB)) {
  console.error(`knowledge.db 不存在: ${KNOWLEDGE_DB}`);
  console.error("请先运行 npm run kb:rebuild");
  process.exit(1);
}

// Wiki 状态
const wikiTotal = existsSync(WIKI_REGISTRY_PATH)
  ? Object.keys(JSON.parse(readFileSync(WIKI_REGISTRY_PATH, "utf-8")).pages || {}).length
  : 0;

server.listen(PORT, () => {
  console.log(`
━━━ 医疗知识库管理面板 ━━━
  地址:  http://localhost:${PORT}/
  DB:    ${KNOWLEDGE_DB}
  Wiki:  ${wikiTotal > 0 ? `${wikiTotal} 页面` : "(未安装)"}
  KG:   ${existsSync(KG_DB_PATH) ? `图谱 DB` : "(无)"}
  元数据: ${existsSync(META_DB) ? META_DB : "(无)"}
  分片数: ${getDb().prepare("SELECT COUNT(*) as c FROM chunks").get().c}

按 Ctrl+C 停止`);
});
