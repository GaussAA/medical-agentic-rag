// retrieval-router/matcher.mjs — KB 文件名匹配 + 摘要 + kb_id 解析

export function loadKbFilenames(db) {
  const rows = db.prepare("SELECT DISTINCT file_path FROM chunks WHERE file_path IS NOT NULL AND file_path <> ''").all();
  return rows.map((r) => r.file_path);
}

export function resolveKbFiles(routedTitles, kbFilenames) {
  const out = [];
  const seen = new Set();
  for (const t of routedTitles || []) {
    const base = String(t || "").replace(/\.md$/i, "");
    let hit = kbFilenames.find((f) => f === base + ".md" || f === t);
    if (!hit) hit = kbFilenames.find((f) => f === base);
    if (!hit) hit = kbFilenames.find((f) => f.includes(base) || base.includes(String(f).replace(/\.md$/i, "")));
    if (hit && !seen.has(hit)) { seen.add(hit); out.push(hit); }
  }
  return out;
}

export function makeSnippet(content, qTok, len = 240) {
  const c = content || "";
  if (!c) return "";
  let pos = -1;
  const lower = c.toLowerCase();
  for (const t of qTok) { if (!t) continue; const i = lower.indexOf(String(t).toLowerCase()); if (i >= 0 && (pos < 0 || i < pos)) pos = i; }
  if (pos < 0) return c.slice(0, len).replace(/\s+/g, " ").trim();
  const start = Math.max(0, pos - 60);
  const end = Math.min(c.length, start + len);
  return (start > 0 ? "…" : "") + c.slice(start, end).replace(/\s+/g, " ").trim() + (end < c.length ? "…" : "");
}

export function resolveKbId(db, kbId) {
  if (!kbId) return null;
  const direct = db.prepare("SELECT 1 FROM chunks WHERE kb_id = ? LIMIT 1").get(kbId);
  if (direct) return kbId;
  try {
    const row = db.prepare("SELECT id FROM knowledge_bases WHERE id = ? OR name = ? LIMIT 1").get(kbId, kbId);
    if (row) return row.id;
  } catch { /* 表不存在 */ }
  return null;
}
