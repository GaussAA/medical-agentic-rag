// guide-router/text.mjs — 文本处理函数

import { ALIASES, GENERIC, PHRASE_ALIASES } from "./vocab.mjs";

export function normalize(s) {
  return String(s || "").toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[　]/g, " ").replace(/[^\p{L}\p{N}]+/gu, " ").replace(/\s+/g, " ").trim();
}

export function tokenize(text) {
  const n = normalize(text);
  if (!n) return new Set();
  const tokens = new Set();
  for (const m of n.match(/[a-z0-9]+/g) || []) tokens.add(m);
  const cjk = n.match(/[一-鿿]+/g) || [];
  for (const w of cjk) { for (const ch of w) tokens.add(ch); for (let i = 0; i < w.length - 1; i++) tokens.add(w.slice(i, i + 2)); }
  for (const t of [...tokens]) { for (const [a, b] of ALIASES) { if (t.includes(a)) { tokens.add(a); tokens.add(b); } } }
  for (const g of GENERIC) tokens.delete(g);
  return tokens;
}

export function applyPhraseAliases(query) {
  let q = query;
  for (const [ph, can] of PHRASE_ALIASES) { if (q.includes(ph)) q = q.replace(ph, can); }
  return q;
}

export function extractYear(query) {
  const m = String(query || "").match(/(\d{4})\s*年?版/);
  return m ? Number(m[1]) : null;
}

export function versionOf(title) {
  const m = String(title || "").match(/(?:（|\()(\d{4})\s*年?版(?:）|\))/);
  return m ? Number(m[1]) : null;
}

export function lev(a, b) {
  const m = a.length, n = b.length;
  if (m === 0) return n; if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) { const cost = a[i - 1] === b[j - 1] ? 0 : 1; d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost); }
  return d[m][n];
}
