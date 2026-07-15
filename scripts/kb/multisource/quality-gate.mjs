// scripts/kb/multisource/quality-gate.mjs
//
// 多源摄取 · 四重质检闸门（医疗刚需，防杜撰/防侵权/防噪声）
//   1. 许可闸门 gateLicense    —— 仅开放许可(CC/PD/OA-Free)通过；付费墙/未知拒
//   2. 权威闸门 gateAuthority   —— 学会指南 > 官方机构 > 期刊论文/数据集
//   3. 时效闸门 gateRecency     —— 优先近窗口年；超龄标红但不硬拒
//   4. 相关闸门 gateRelevance    —— 正文/标题须命中目标疾病关键词
//
// 纯函数：无网络、无 I/O，可原生 node 直接单测。
// 候选对象统一形状（由各 adapter 产出）：
//   { title, url, source, license, openAccess, authority, year, text, disease }

// ── 候选权威等级（数值越高越权威，用于排序与红线）──
export const AUTHORITY = {
  GUIDELINE: 5,   // 学会/官方发布的临床实践指南、 consensus、statement
  OFFICIAL: 4,    // 政府/官方机构文件
  SOCIETY: 3,     // 学会但非指南(如立场文件)、高质量综述
  DATASET: 2,     // 开源医学数据集/知识库
  PAPER: 1,       // 普通研究论文
  UNKNOWN: 0,
};

// 已知开放许可标识（SPDX id / 常见标签 / OA URL 片段），小写匹配
const KNOWN_OPEN = [
  "cc0", "cc-by", "cc by", "cc-by-sa", "cc-by-nc", "cc-by-nc-sa",
  "creative commons", "creativecommons.org",
  "public domain", "publicdomain", "open access", "openaccess",
  "free to read", "free access", "free full text", "oa",
  "mit", "apache", "bsd", "gpl", "unlicense", "isc", "wtfpl", "mpl",
];
// 付费墙/非开放信号（命中即拒）
const PAYWALLED = [
  "paywall", "subscription required", "subscription only",
  "all rights reserved", "restricted access", "embargo", "non-open",
  "closed access", "not open",
];

function norm(s) {
  return (s || "").toString().trim().toLowerCase();
}

/**
 * 许可闸门。
 * @param {{license?:string, openAccess?:boolean, licenseUrl?:string}} cand
 * @returns {{pass:boolean, reason:string}}
 */
export function gateLicense(cand) {
  const lic = norm(cand.license);
  const url = norm(cand.licenseUrl);
  const isOA = !!cand.openAccess;

  if (PAYWALLED.some((h) => lic.includes(h) || url.includes(h))) {
    return { pass: false, reason: `疑似付费墙: ${lic || url}` };
  }
  // 显式开放许可
  const hitOpen = KNOWN_OPEN.some((o) => lic.includes(o) || url.includes(o));
  if (hitOpen) return { pass: true, reason: `开放许可: ${lic || url || "OA标记"}` };

  // 无明确许可字符串，但来源以 openAccess 标志声明为 OA（如 Europe PMC isOpenAccess+Free）
  if (!lic && isOA) {
    return { pass: true, reason: "以 openAccess 标志声明为开放获取(无显式许可串)" };
  }
  if (!lic && !isOA) {
    return { pass: false, reason: "许可缺失且未声明开放获取" };
  }
  // 有许可串但不识别为开放 → 保守拒（医疗内容宁可漏收不可误收侵权）
  return { pass: false, reason: `许可未识别为开放: ${lic}` };
}

/**
 * 权威闸门（返回分数，不入参即 0）。
 * @param {{authority?:string, source?:string}} cand
 */
export function gateAuthority(cand) {
  const a = norm(cand.authority);
  let score = AUTHORITY.UNKNOWN;
  let label = "unknown";
  if (a.includes("guideline") || a.includes("consensus") || a.includes("statement")) {
    score = AUTHORITY.GUIDELINE; label = "guideline";
  } else if (a.includes("official") || a.includes("government") || a.includes("ministr")) {
    score = AUTHORITY.OFFICIAL; label = "official";
  } else if (a.includes("society") || a.includes("review") || a.includes("协会") || a.includes("学会")) {
    score = AUTHORITY.SOCIETY; label = "society";
  } else if (a.includes("dataset") || a.includes("knowledge base") || a.includes("数据集") || a.includes("知识库")) {
    score = AUTHORITY.DATASET; label = "dataset";
  } else if (a.includes("paper") || a.includes("article") || a.includes("论文") || a.includes("研究")) {
    score = AUTHORITY.PAPER; label = "paper";
  }
  return { score, label };
}

/**
 * 时效闸门。
 * @param {{year?:number|string}} cand
 * @param {object} [opts] { nowYear, maxAge=10 }
 * @returns {{pass:boolean, stale:boolean, reason:string}}
 */
export function gateRecency(cand, opts = {}) {
  const nowYear = opts.nowYear || new Date().getFullYear();
  const maxAge = opts.maxAge ?? 10;
  const y = typeof cand.year === "string" ? parseInt(cand.year, 10) : cand.year;
  if (!y || isNaN(y)) {
    return { pass: true, stale: false, reason: "无年份(不拦截但标注)" };
  }
  const age = nowYear - y;
  if (age < 0) return { pass: true, stale: false, reason: `未来年份 ${y}(异常但放行)` };
  if (age <= maxAge) return { pass: true, stale: false, reason: `${y} 年(${age}年内)` };
  return { pass: true, stale: true, reason: `${y} 年(超 ${maxAge} 年窗口，标红待人工复核)` };
}

/**
 * 相关闸门：标题或正文须命中目标疾病关键词。
 * @param {{title?:string, text?:string, disease?:string, keywords?:string[]}} cand
 * @returns {{pass:boolean, hits:string[], reason:string}}
 */
export function gateRelevance(cand, diseaseOpts = {}) {
  const target = (cand.disease || diseaseOpts.disease || "").trim();
  const kws = (diseaseOpts.keywords || [])
    .concat(target ? [target] : [])
    .filter(Boolean)
    .map((k) => k.trim())
    .filter((k) => k.length >= 2);
  const title = (cand.title || "").toLowerCase();
  const body = cand.text ? cand.text.slice(0, 4000).toLowerCase() : "";
  // 排歧词：命中词若落入排歧词上下文窗口(±40字)内，视为无效命中
  // 例：高血压排除 "pulmonary" → "Pulmonary Hypertension" 不误判为系统性高血压
  const exclude = (diseaseOpts.excludeTerms || []).map((e) => e.toLowerCase()).filter(Boolean);

  const inExcludeContext = (hit, hay) => {
    if (!exclude.length) return false;
    let idx = hay.indexOf(hit);
    while (idx !== -1) {
      for (const ex of exclude) {
        const exIdx = hay.indexOf(ex, Math.max(0, idx - 40));
        if (exIdx !== -1 && exIdx <= idx + hit.length + 40) return true;
      }
      idx = hay.indexOf(hit, idx + 1);
    }
    return false;
  };

  // 强相关词：疾病中文名 + 英文核心词(coreEn，可为字符串或数组) + 各核心词尾词。
  // 仅强词命中方可代表「主题明确」；弱词(症状/药物/检验)不放低权威文献串味。
  const coreEnRaw = diseaseOpts.coreEn;
  const coreEnList = Array.isArray(coreEnRaw)
    ? coreEnRaw
    : (coreEnRaw ? [coreEnRaw] : []);
  const strong = [target].filter((k) => k.length >= 2);
  for (const ce of coreEnList) {
    const ceLower = String(ce || "").trim().toLowerCase();
    if (!ceLower) continue;
    strong.push(ceLower);
    const lw = ceLower.split(/\s+/).pop();
    if (lw && lw !== ceLower) strong.push(lw);
  }
  const strongSet = [...new Set(strong.map((k) => k.toLowerCase()).filter(Boolean))];

  const titleHasStrong = strongSet.some((k) => title.includes(k) && !inExcludeContext(k, title));
  const bodyStrongHits = [...new Set(strongSet.filter((k) => body.includes(k) && !inExcludeContext(k, body)))].length;

  const auth = gateAuthority({ authority: diseaseOpts.authority || cand.authority });
  const authLevel = auth.score;

  // 相关阈值（精度优先，防串味）：
  //   ① 标题含强词（主题明确）→ 入仓；
  //   ② 高权威(guideline/consensus/society) 且正文含≥1强词 → 入仓（指南常以「依从性/共识」冠标题而非病名）；
  //   ③ 正文含≥6强词（低权威但深度论述该病）→ 入仓；
  //   低权威文献仅正文偶提(如 COPD 论文蹭哮喘词、肥大细胞增多症偶提骨质疏松) → 拒。
  const pass = titleHasStrong
    || (authLevel >= AUTHORITY.SOCIETY && bodyStrongHits >= 1)
    || bodyStrongHits >= 6;

  const hits = [...new Set([
    ...strongSet.filter((k) => title.includes(k) || body.includes(k)),
    ...kws.filter((k) => title.includes(k.toLowerCase()) || body.includes(k.toLowerCase())),
  ])];
  return {
    pass,
    hits,
    titleHasStrong,
    bodyStrongHits,
    authority: auth.label,
    reason: pass
      ? `强相关命中: ${hits.slice(0, 6).join("、")}`
      : "未达强相关阈值(低权威文献须标题含病名/英文核心词；高权威须正文含病名)",
  };
}

/**
 * 聚合四重闸门，输出最终裁决。
 * @param {object} cand 候选对象
 * @param {object} [opts] { disease, keywords, nowYear, maxAge, minAuthority }
 * @returns {{pass:boolean, score:number, reasons:string[], flags:string[]}}
 */
export function evaluateCandidate(cand, opts = {}) {
  const reasons = [];
  const flags = [];

  const lic = gateLicense(cand);
  reasons.push(`许可: ${lic.reason}`);
  if (!lic.pass) {
    return { pass: false, score: 0, reasons, flags };
  }

  const auth = gateAuthority(cand);
  reasons.push(`权威: ${auth.label}(${auth.score})`);
  const minAuth = opts.minAuthority ?? AUTHORITY.PAPER; // 默认论文级即可，指南优先靠排序
  if (auth.score < minAuth) {
    flags.push(`权威偏低(${auth.label})`);
  }

  const rec = gateRecency(cand, opts);
  reasons.push(`时效: ${rec.reason}`);
  if (rec.stale) flags.push("超龄");

  const rel = gateRelevance(cand, opts);
  reasons.push(`相关: ${rel.reason}`);
  if (!rel.pass) {
    return { pass: false, score: 0, reasons, flags };
  }

  // 综合分：权威为主，相关命中数加成，超龄减分
  let score = auth.score * 10 + rel.hits.length * 2 - (rec.stale ? 5 : 0);
  if (flags.length === 0) score += 5; // 干净加成

  return { pass: true, score, reasons, flags };
}
