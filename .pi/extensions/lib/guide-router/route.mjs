// guide-router/route.mjs — 路由主逻辑

import { normalize, tokenize, applyPhraseAliases, extractYear, versionOf, lev } from "./text.mjs";
import { loadIndex, buildIdf, buildGuideTokens } from "./index.mjs";
import { cacheGet, cacheSet } from "../retrieval-cache.mjs";

const MIN_SCORE = 4;
const W_SINGLE_CHAR = 0.25;
const ROUTE_CONFIDENCE_MIN = Number(process.env.ROUTE_CONFIDENCE_MIN) || 12;

// ── 疾病类别映射（用于跨领域降权）──
// key: 疾病简称（必须出现在 query 或 guide 的 disease 字段中才会触发匹配）
// value: 类别名。同类别不降权，不同类别大幅降权。
const DZ_CATEGORIES = {
  // 代谢
  "糖尿病": "代谢", "糖尿": "代谢", "肥胖": "代谢", "高血糖": "代谢",
  "高脂": "代谢", "血脂": "代谢", "痛风": "代谢", "高尿酸": "代谢",
  // 骨骼
  "骨质疏松": "骨骼", "骨松": "骨骼", "骨折": "骨骼", "骨关节": "骨骼",
  "关节炎": "骨骼", "关节": "骨骼",
  // 心血管
  "高血压": "心血管", "冠心病": "心血管", "心梗": "心血管", "心衰": "心血管",
  "心力衰竭": "心血管", "心肌梗死": "心血管", "房颤": "心血管", "心律": "心血管",
  "心绞痛": "心血管", "冠脉": "心血管", "冠状动脉": "心血管",
  // 脑血管/神经
  "脑卒中": "神经", "中风": "神经", "卒中": "神经", "癫痫": "神经",
  "帕金森": "神经", "痴呆": "神经", "脑梗": "神经", "阿兹海默": "神经",
  // 呼吸
  "肺炎": "呼吸", "哮喘": "呼吸", "慢阻肺": "呼吸", "COPD": "呼吸",
  "肺": "呼吸", "肺结核": "呼吸", "结核": "呼吸",
  // 消化
  "幽门螺杆菌": "消化", "胃炎": "消化", "溃疡": "消化",
  "胰腺炎": "消化", "肝硬化": "消化", "肝炎": "消化", "肝": "消化",
  "胰腺": "消化", "肠": "消化",
  // 肿瘤
  "肝癌": "肿瘤", "肺癌": "肿瘤", "乳腺癌": "肿瘤", "胃癌": "肿瘤",
  "肠癌": "肿瘤", "食管癌": "肿瘤", "甲状腺癌": "肿瘤", "宫颈癌": "肿瘤",
  "卵巢癌": "肿瘤", "前列腺癌": "肿瘤", "黑色素瘤": "肿瘤", "淋巴瘤": "肿瘤",
  "白血病": "肿瘤", "癌": "肿瘤", "肿瘤": "肿瘤",
  // 肾脏
  "肾病": "肾脏", "肾": "肾脏", "透析": "肾脏", "血透": "肾脏",
  // 血液
  "贫血": "血液", "血友病": "血液", "溶血": "血液",
  // 感染
  "艾滋病": "感染", "HIV": "感染", "乙肝": "感染", "乙型肝炎": "感染",
  "新冠": "感染", "冠状病毒": "感染", "病毒": "感染",
  // 妇产
  "妊娠": "妇产", "孕妇": "妇产", "产后": "妇产", "胎盘": "妇产",
  "哺乳": "妇产", "围产": "妇产", "宫颈": "妇产",
  // 儿科
  "儿童": "儿科", "小儿": "儿科", "新生儿": "儿科",
  // 老年
  "老年": "老年", "高龄": "老年",
  // 口腔
  "口腔": "口腔", "牙": "口腔", "颌": "口腔", "唇": "口腔", "腭": "口腔", "舌": "口腔",
  // 精神
  "抑郁": "精神", "焦虑": "精神", "失眠": "精神", "精神": "精神",
  // 皮肤
  "皮肤": "皮肤", "过敏": "皮肤", "皮炎": "皮肤", "皮疹": "皮肤",
  // 内分泌
  "甲状腺": "内分泌", "甲亢": "内分泌", "甲减": "内分泌",
  // 耳鼻喉
  "耳": "五官", "鼻": "五官", "喉": "五官", "咽": "五官",
};

// ── 查询→科室模式（用于指南预过滤）──
// 当查询内容明确指向某个科室时，只对该科室的指南算分，提升准确率+性能。
const QUERY_DEPT_PATTERNS = [
  { dept: "心血管内科", patterns: [/高血压|冠心病|心衰|房颤|心律|心绞痛|冠脉|心肌|心梗/] },
  { dept: "神经内科", patterns: [/脑卒中|中风|卒中|脑梗|癫痫|帕金森|痴呆|阿兹海默/] },
  { dept: "呼吸内科", patterns: [/肺炎|哮喘|慢阻肺|COPD|肺部感染|呼吸衰竭/] },
  { dept: "消化内科", patterns: [/胃炎|溃疡|幽门螺杆菌|胰腺炎|肝硬化|肠炎|腹泻/] },
  { dept: "肿瘤科", patterns: [/肝癌|肺癌|胃癌|肠癌|食管癌|乳腺癌|甲状腺癌|宫颈癌|卵巢癌|前列腺癌|癌|肿瘤/] },
  { dept: "内分泌代谢科", patterns: [/糖尿病|糖尿|肥胖|高血糖|高脂|血脂|甲状腺|甲亢|甲减/] },
  { dept: "肾内科", patterns: [/肾病|透析|血透|肾炎|肾衰/] },
  { dept: "妇产科", patterns: [/妊娠|孕妇|产后|围产|哺乳|宫颈|妇科|剖宫产/] },
  { dept: "儿科", patterns: [/儿童|小儿|新生儿|婴幼儿/] },
  { dept: "骨科", patterns: [/骨折|关节|脊柱|骨松|骨质疏松/] },
  { dept: "感染科", patterns: [/感染|结核|乙肝|艾滋|新冠|病毒性肝炎/] },
  { dept: "血液科", patterns: [/贫血|血友病|溶血|白血病/] },
  { dept: "精神科", patterns: [/抑郁|焦虑|失眠|精神/] },
  { dept: "皮肤科", patterns: [/皮肤|皮炎|皮疹/] },
  { dept: "风湿免疫科", patterns: [/风湿|痛风|类风湿|红斑狼疮/] },
  { dept: "眼科", patterns: [/眼|视力|白内障|青光眼/] },
];

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
  let guideMap = idx.guideMap || {};

  // ── 科室预过滤（提升准确率+性能）──
  // 当查询明确指向某科室时，只对该科室的指南算分
  let detectedDept = null;
  const matchedDepts = [];
  for (const { dept, patterns } of QUERY_DEPT_PATTERNS) {
    if (patterns.some((re) => re.test(qNorm))) {
      matchedDepts.push(dept);
    }
  }
  if (matchedDepts.length === 1) {
    detectedDept = matchedDepts[0];
    const filtered = {};
    for (const [title, info] of Object.entries(guideMap)) {
      if (info.department === detectedDept || !info.department) {
        // 无 department 的指南也保留（兼容旧索引）
        filtered[title] = info;
      }
    }
    if (Object.keys(filtered).length >= 3) {
      guideMap = filtered; // 至少保留 3 篇，避免过滤后空集
    }
  }
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

    // ── EuropePMCOA 英文指南降权 ──
    // 该类指南为英文文献的中文结构化摘引，中文标题仅为检索锚点，
    // 正文为英文原文。当同病种有中文原生指南时不应占 Top1。
    if (/EuropePMCOA/i.test(title)) {
      const ci = score;
      score *= 0.5;
      reasons.push(`EuropePMCOA英文指南降权(${ci.toFixed(1)}→${score.toFixed(1)})`);
    }

    // ── 跨疾病领域降权 ──
    // 若 query 明确提到某疾病、但指南属于完全不同的疾病领域，大幅降权
    const queryMatchedCats = new Set();
    const guideMatchedCats = new Set();
    for (const [dz, cat] of Object.entries(DZ_CATEGORIES)) {
      if (qNorm.includes(dz)) queryMatchedCats.add(cat);
      const guideText = (title + " " + (info.disease || "")).toLowerCase();
      if (guideText.includes(dz)) guideMatchedCats.add(cat);
    }
    if (queryMatchedCats.size > 0 && guideMatchedCats.size > 0) {
      const hasOverlap = [...queryMatchedCats].some((c) => guideMatchedCats.has(c));
      if (!hasOverlap) {
        score *= 0.25;
        reasons.push(
          `跨领域降权(查${[...queryMatchedCats].join("/")}/文${[...guideMatchedCats].join("/")})`,
        );
      }
    }

    if (qYear != null && candYear != null && candYear !== qYear) continue;
    if (score > 0 && hasStrong) {
      scored.push({ title, id: info.id || title, disease: info.disease || "", version: candYear, normalizedDisease: candNorm, audience: info.audience || null, department: info.department || null, deprecated: info.deprecated === true, sectionCount: info.sectionCount ?? null, keyParagraphCount: info.keyParagraphCount ?? null, score, reasons, matchedKeywords: matchedKw });
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
  const result = { query, top, totalMatched: scored.length, semantic: useSemantic, cached: false, topScore, lowConfidence, detectedDept };
  if (useCache) cacheSet(cacheKey, result);
  return result;
}
