// retrieval-router/fts.mjs — FTS5 trigram 中文召回索引

import { existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { Database } from "./db.mjs";
import { normalize, tokenize } from "../guide-router.mjs";
import { diag } from "../diagnostic-log.mjs";

export function ftsDbPath() { return join(process.cwd(), ".pi", "cache", "retrieval-fts.db"); }

let _ftsDb = null;
let _ftsSig = null;
let _ftsPathOverride = null;

export function setFtsDbPath(p) { _ftsPathOverride = p; resetFtsDb(); }

export function resetFtsDb() { if (_ftsDb) { try { _ftsDb.close(); } catch {} } _ftsDb = null; _ftsSig = null; }

const MAX_FTS_CANDIDATES = 800;

export function ftsQueryTokens(query) {
  const n = normalize(query);
  if (!n) return [];
  const tokens = [];
  for (const w of n.match(/[一-鿿]+/g) || []) { if (w.length < 3) continue; for (let i = 0; i + 3 <= w.length; i++) tokens.push(w.slice(i, i + 3)); }
  for (const m of n.match(/[a-z0-9]+/g) || []) { if (m.length >= 3) tokens.push(m); }
  return [...new Set(tokens)];
}

export function ftsCandidateIds(ftsDb, query) {
  const tokens = ftsQueryTokens(query);
  if (tokens.length === 0) return null;
  const seen = new Set();
  const out = [];
  try {
    const stmt = ftsDb.prepare("SELECT chunk_id FROM chunks_fts WHERE content MATCH ?");
    for (const t of tokens) { const rows = stmt.all(`"${t.replace(/"/g, '""')}"`); for (const r of rows) if (!seen.has(r.chunk_id)) { seen.add(r.chunk_id); out.push(r.chunk_id); } }
  } catch (e) { diag.error("retrieval-router", "FTS 异常，降级全扫: " + e.message); return null; }
  return out;
}

export function buildFtsIndex(srcDb, ftsDb, sig) {
  ftsDb.exec("DROP TABLE IF EXISTS chunks_fts");
  ftsDb.exec("DROP TABLE IF EXISTS meta");
  ftsDb.exec("DROP TABLE IF EXISTS df");
  ftsDb.exec("CREATE VIRTUAL TABLE chunks_fts USING fts5(content, chunk_id UNINDEXED, file_path UNINDEXED, kb_id UNINDEXED, tokenize='trigram')");
  ftsDb.exec("CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT)");
  ftsDb.exec("CREATE TABLE df (token TEXT PRIMARY KEY, df INTEGER NOT NULL)");
  const insFts = ftsDb.prepare("INSERT INTO chunks_fts(rowid, content, chunk_id, file_path, kb_id) VALUES (?, ?, ?, ?, ?)");
  const insMeta = ftsDb.prepare("INSERT OR REPLACE INTO meta(k, v) VALUES (?, ?)");
  const insDf = ftsDb.prepare("INSERT OR REPLACE INTO df(token, df) VALUES (?, ?)");
  const total = srcDb.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const tx = ftsDb.transaction(() => {
    const rows = srcDb.prepare("SELECT rowid, id, content, file_path, kb_id FROM chunks").all();
    const dfMap = new Map();
    for (const r of rows) {
      insFts.run(r.rowid, r.content || "", r.id, r.file_path || "", r.kb_id || "");
      for (const tk of new Set(tokenize(r.content || ""))) dfMap.set(tk, (dfMap.get(tk) || 0) + 1);
    }
    for (const [tk, d] of dfMap) insDf.run(tk, d);
    insMeta.run("sig", sig);
    insMeta.run("total", String(total));
  });
  tx();
}

export function sourceSig(srcDb) {
  const row = srcDb.prepare("SELECT COUNT(*) n, COALESCE(MAX(indexed_at), 0) mx, COALESCE(SUM(length(content)), 0) cl FROM chunks").get();
  return `${row.n}:${row.mx}:${row.cl}`;
}

export function ensureFtsIndex(srcDb, ftsPathOverride) {
  if (!srcDb) return null;
  let isMemory = false;
  try { isMemory = srcDb.name === ":memory:"; } catch (e) { diag.info("retrieval-router", "srcDb.name 读取失败: " + (e?.message || e)); }
  if (isMemory) return null;
  const ftsPath = ftsPathOverride || _ftsPathOverride || ftsDbPath();
  let sig;
  try { sig = sourceSig(srcDb); } catch (e) { diag.error("retrieval-router", "源库签名失败，降级全扫: " + (e?.message || e)); return null; }
  const usingDefault = !ftsPathOverride && !_ftsPathOverride;
  if (usingDefault && _ftsDb && _ftsSig === sig) return _ftsDb;
  let db;
  try { mkdirSync(dirname(ftsPath), { recursive: true }); db = new Database(ftsPath); } catch (e) { diag.error("retrieval-router", "无法打开 FTS 库: " + e.message); return null; }
  let needBuild = true;
  try { const m = db.prepare("SELECT v FROM meta WHERE k='sig' LIMIT 1").get(); if (m && m.v === sig) needBuild = false; } catch (e) { diag.info("retrieval-router", "meta 读取失败，强制重建"); needBuild = true; }
  if (needBuild) {
    try { buildFtsIndex(srcDb, db, sig); } catch (e) {
      diag.error("retrieval-router", "FTS 构建失败，降级全扫: " + e.message);
      try { db.close(); } catch {}
      try { unlinkSync(ftsPath); } catch {}
      return null;
    }
  }
  if (usingDefault) { _ftsDb = db; _ftsSig = sig; }
  return db;
}

export function getFtsDb(srcDb) { return ensureFtsIndex(srcDb); }
