// guide-router/route.mjs — 路由主逻辑

import { normalize, tokenize, applyPhraseAliases, extractYear, versionOf, lev } from "./text.mjs";
import { loadIndex, buildIdf, buildGuideTokens } from "./index.mjs";
import { cacheGet, cacheSet } from "../retrieval-cache.mjs";

const MIN_SCORE = 4;
const W_SINGLE_CHAR = 0.25;
const ROUTE_CONFIDENCE_MIN = Number(process.env.ROUTE_CONFIDENCE_MIN) || 12;

export function routeGuides(query, opts = {}) {
  const { index, topK = 5, useSemantic = true, useCache = true, baseDir, confidenceMin = ROUTE_CONFIDENCE_MIN } = opts;
  const idx = index || loadIndex(baseDir);
  const idf = buildIdf(idx);
  const gtok = buildGuideTokens(idx);
  const qAliased = applyPhraseAliases(query);
  const qNorm = normalize(qAliased);
  const qYear = extractYear(qAliased);
  const cacheKey = `route:${ROUTE_CONFIDENCE_MIN}:${qNorm}`;

  if (useCache) { const hit = cacheGet(cacheKey); if (hit) return { ...hit, cached: true }; }
  if (!qNorm) return { query, top: [], totalMatched: 0, semantic: useSemantic, cached: false, topScore: 0, lowConfidence: true };

  const qTokens = tokenize(qAliased);
  const kwIndex = idx.keywordIndex || {};
  const guideMap = idx.guideMap || {};
  const scored = [];

  for (const [title, info] of Object.entries(guideMap)) {
    let score = 0, reasons = [];
    const matchedKw = [];
    for (const [kw, guides] of Object.entries(kwIndex)) {
      const k = kw.toLowerCase();
      if (k === qNorm || k.includes(qNorm) || qNorm.includes(k)) { if (Array.isArray(guides) && guides.includes(title)) matchedKw.push(kw); }
    }
    if (matchedKw.length) { score += matchedKw.length * 5; reasons.push(`关键词命中:${matchedKw.slice(0, 3).join("/")}`); }

    const candYear = info.version ?? versionOf(title);
    const candNorm = info.normalizedDisease || info.disease || "";
    const titleL = title.toLowerCase();
    const disease = (info.disease || "").toLowerCase();
    if (titleL.includes(qNorm) || disease.includes(qNorm)) { score += 4; reasons.push("标题/疾病包含"); }

    if (useSemantic) {
      const toks = gtok.get(title) || { primary: new Set(), secondary: new Set() };
      let semScore = 0; const hitTokens = [];
      for (const t of qTokens) {
        if (!idf.has(t)) continue;
        let w = 0;
        if (toks.primary.has(t)) w = 1;
        else if (toks.secondary.has(t)) w = 0.35;
        if (w > 0) { const charW = t.length === 1 && /[\u4e00-\u9fff]/.test(t) ? 0.25 : 1; semScore += w * charW * (1 + idf.get(t)); if (hitTokens.length < 5) hitTokens.push(t); }
      }
      if (semScore > 0) { score += semScore; reasons.push(`语义重叠(IDF加权)${semScore.toFixed(1)}(${hitTokens.join("/")})`); }
      let fuzzy = 0;
      const qtokensLong = [...qTokens].filter((t) => t.length >= 3 && idf.has(t));
      for (const qt of qtokensLong) { for (const gt of toks.primary) { if (gt.length >= 3 && lev(qt, gt) === 1) { fuzzy++; break; } } }
      if (fuzzy) { score += fuzzy; reasons.push(`模糊匹配×${fuzzy}`); }
    }

    if (qYear != null && candYear != null) {
      if (candYear === qYear) { score += 12; reasons.push(`年份精确匹配${qYear}`); }
      else { score -= 3; reasons.push(`年份不符(查${qYear}/文${candYear})`); }
    }

    const hasStrong = matchedKw.length > 0 || titleL.includes(qNorm) || disease.includes(qNorm) || score >= 4;
    const isNonDiseaseGuide = /^(ws|gbz)|质量控制/.test(title) || (info.disease && info.disease.length > 12);
    if (isNonDiseaseGuide && matchedKw.length === 0) { score *= 0.4; reasons.push("非疾病类降权"); }
    const isSummaryGuide = /各专业|质控工作改进目标|工作改进目标|改进目标|年度目标|总览|综述|汇总/.test(title) || /各专业|质控工作改进目标|改进目标/.test(info.id || "");
    if (isSummaryGuide) { score *= 0.4; reasons.push("汇总类指南降权"); }
    if (matchedKw.length === 0 && !titleL.includes(qNorm) && !disease.includes(qNorm)) { score *= 0.6; reasons.push("纯语义降权"); }

    const isPregnancyWs = /^(ws|gbz)/i.test(title) && /妊娠|孕妇|围产|妇女/.test(title + (info.disease || ""));
    const qMentionsPregnancy = /妊娠|孕妇|围产/.test(qNorm);
    if (isPregnancyWs && !qMentionsPregnancy && matchedKw.length > 0) { score *= 0.6; reasons.push("WS妊娠亚人群非语境降权"); }

    if (qYear != null && candYear != null && candYear !== qYear) continue;
    if (score > 0 && hasStrong) {
      scored.push({ title, id: info.id || title, disease: info.disease || "", version: candYear, normalizedDisease: candNorm, audience: info.audience || null, deprecated: info.deprecated === true, sectionCount: info.sectionCount ?? null, keyParagraphCount: info.keyParagraphCount ?? null, score, reasons, matchedKeywords: matchedKw });
    }
  }

  scored.sort((a, b) => {
    const aScore = a.score - (a.deprecated && a.version != null ? 10 : 0);
    const bScore = b.score - (b.deprecated && b.version != null ? 10 : 0);
    if (bScore !== aScore) return bScore - aScore;
    const an = a.normalizedDisease || "", bn = b.normalizedDisease || "";
    if (an && an === bn && (a.audience || null) === (b.audience || null)) { const av = a.version || 0, bv = b.version || 0; if (av !== bv) return bv - av; }
    if (b.score !== a.score) return b.score - a.score;
    const aE = a.title.toLowerCase().includes(qNorm) || a.disease.toLowerCase().includes(qNorm) ? 0 : 1;
    const bE = b.title.toLowerCase().includes(qNorm) || b.disease.toLowerCase().includes(qNorm) ? 0 : 1;
    return aE - bE;
  });

  const top = scored.slice(0, topK);
  const topScore = top.length ? top[0].score : 0;
  const lowConfidence = top.length === 0 || topScore < confidenceMin;
  const result = { query, top, totalMatched: scored.length, semantic: useSemantic, cached: false, topScore, lowConfidence };
  if (useCache) cacheSet(cacheKey, result);
  return result;
}
