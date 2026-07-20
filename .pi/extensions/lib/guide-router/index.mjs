// guide-router/index.mjs — 指南索引管理

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tokenize } from "./text.mjs";

export function loadIndex(baseDir = process.cwd()) {
  const p = join(baseDir, "data", "kb", ".guide-index.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

export function buildIdf(idx) {
  if (idx._idf) return idx._idf;
  const guideMap = idx.guideMap || {};
  const N = Math.max(1, Object.keys(guideMap).length);
  const df = new Map();
  for (const info of Object.values(guideMap)) {
    for (const t of tokenize([info.id || "", info.disease || "", (info.keywords || []).join(" ")].join(" "))) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(N / Math.max(1, d)));
  idx._idf = idf;
  return idf;
}

const W_SECONDARY = 0.35;

export function buildGuideTokens(idx) {
  if (idx._gtok) return idx._gtok;
  const map = new Map();
  for (const [title, info] of Object.entries(idx.guideMap || {})) {
    map.set(title, { primary: tokenize([info.id || "", info.disease || ""].join(" ")), secondary: tokenize((info.keywords || []).join(" ")) });
  }
  idx._gtok = map;
  return map;
}
