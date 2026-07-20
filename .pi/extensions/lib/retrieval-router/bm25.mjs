// retrieval-router/bm25.mjs — BM25 排序

import { getDb, safeJson, Database } from "./db.mjs";
import { loadKbFilenames, resolveKbFiles, resolveKbId, makeSnippet } from "./matcher.mjs";
import { ftsCandidateIds, ftsDbPath, getFtsDb } from "./fts.mjs";
import { normalize, tokenize, routeGuides, loadIndex } from "../guide-router.mjs";

export function lexicalSearch(db, query, opts = {}) {
  const { limit = 8, kbFiles = null, kbId = null, ftsDb = null } = opts;
  const qNorm = normalize(query);
  if (!qNorm) return [];
  const qTok = tokenize(query);
  if (qTok.size === 0) return [];

  let candidateIds = null;
  const fdb = opts.ftsDb === false ? null : ftsDb || getFtsDb(db);
  if (fdb) { const ids = ftsCandidateIds(fdb, query); if (ids && ids.length && ids.length <= 800) candidateIds = ids; }

  let likeTerm = null;
  if (!candidateIds && qNorm.length >= 2 && qNorm.length <= 4) {
    const cjk = qNorm.match(/^[一-鿿]{2,4}$/);
    if (cjk && (!kbFiles || !kbFiles.length)) likeTerm = cjk[0];
  }

  let sql = "SELECT id, file_path, content, metadata_json FROM chunks WHERE 1=1";
  const params = [];
  if (candidateIds) { const ph = candidateIds.map(() => "?").join(","); sql += ` AND id IN (${ph})`; params.push(...candidateIds); }
  if (likeTerm) { sql += " AND content LIKE ?"; params.push(`%${likeTerm}%`); }
  if (kbId) { const realKb = resolveKbId(db, kbId); if (realKb) { sql += " AND kb_id = ?"; params.push(realKb); } }
  if (kbFiles && kbFiles.length) { const ph = kbFiles.map(() => "?").join(","); sql += ` AND file_path IN (${ph})`; params.push(...kbFiles); }

  const rows = db.prepare(sql).all(...params);
  if (rows.length === 0) return [];

  let N; let df;
  if (candidateIds && fdb) {
    N = Number(fdb.prepare("SELECT v FROM meta WHERE k='total'").get().v);
    df = new Map();
    const getDf = fdb.prepare("SELECT df FROM df WHERE token = ?");
    for (const qt of qTok) { const r = getDf.get(qt); if (r) df.set(qt, r.df); }
  } else {
    N = rows.length; df = new Map();
    for (const r of rows) { for (const tk of new Set(tokenize(r.content || ""))) df.set(tk, (df.get(tk) || 0) + 1); }
  }
  const idf = (t) => Math.log(N / Math.max(1, df.get(t) || 0));

  const scored = [];
  for (const r of rows) {
    const counts = new Map();
    for (const tk of tokenize(r.content || "")) counts.set(tk, (counts.get(tk) || 0) + 1);
    let score = 0; let hitCount = 0;
    for (const qt of qTok) {
      if (!df.has(qt)) continue;
      const tf = counts.get(qt) || 0;
      if (tf > 0) { score += (1 + idf(qt)) * tf; hitCount++; }
    }
    if (score > 0) scored.push({ file_path: r.file_path, score, hitCount, content: r.content, metadata: safeJson(r.metadata_json) });
  }
  scored.sort((a, b) => b.score - a.score || b.hitCount - a.hitCount || (a.file_path < b.file_path ? -1 : a.file_path > b.file_path ? 1 : 0));

  const qTokArr = [...qTok];
  return scored.slice(0, limit).map((r) => ({
    file_path: r.file_path, score: Number(r.score.toFixed(2)), hitCount: r.hitCount,
    snippet: makeSnippet(r.content || "", qTokArr), metadata: r.metadata,
  }));
}

export function searchKnowledge(query, opts = {}) {
  const { limit = 8, kbId = null, useRouting = true, index = null, baseDir = null } = opts;
  const db = getDb();
  if (!db) return { results: [], routedTitles: [], kbFiles: [], constrained: false, totalFiles: 0, error: "knowledge db unavailable" };

  const kbFilesAll = loadKbFilenames(db);
  let kbFiles = null; let routedTitles = []; let lowConfidence = false; let topScore = 0;

  if (useRouting) {
    const idx = index || loadIndex(baseDir || undefined);
    const rr = routeGuides(query, { index: idx });
    routedTitles = rr.top.map((g) => g.title);
    lowConfidence = !!rr.lowConfidence;
    topScore = rr.topScore || 0;
    kbFiles = lowConfidence ? null : resolveKbFiles(routedTitles, kbFilesAll);
  }

  const constrained = !!(kbFiles && kbFiles.length);
  const fetchLimit = constrained ? Math.max(limit * 3, 20) : limit;
  const results = lexicalSearch(db, query, { limit: fetchLimit, kbFiles, kbId });

  return {
    results: results.slice(0, limit), routedTitles, kbFiles, constrained,
    lowConfidence, topScore, totalFiles: kbFilesAll.length,
  };
}
