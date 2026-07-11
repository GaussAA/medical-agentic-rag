// guide-router.mjs
// 指南路由纯函数：根据查询定位应检索的指南（一份或多份）。
//
// 在原有「关键词索引 / 标题字面匹配」基础上，新增三层语义路由能力：
//   1) 词元化：CJK 按字 + 二元组（bigram）、拉丁/数字按词，覆盖无分词的中文短语重叠；
//   2) 医学同义词扩展：恶性肿瘤→肿瘤、化疗→化学治疗、靶向→靶向治疗 等常见别名归一；
//   3) 模糊匹配：对未命中且长度≥3 的词元做 Levenshtein 距离=1 的容错（别字/缩写）。
// 最终按加权得分排序，并附带「命中依据(reasons)」以提升医疗场景可解释性/可审计性。
//
// 纯 JavaScript（.mjs），无 TS 语法：供 guide-finder.ts（经 jiti）与 tests/unit/eval-bench.mjs（原生 node）共用。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheGet, cacheSet } from "./retrieval-cache.mjs";

/** 归一化：小写、全角转半角、去标点、压扁空白。 */
export function normalize(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, (c) =>
      String.fromCharCode(c.charCodeAt(0) - 0xfee0),
    )
    .replace(/[　]/g, " ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * 医学同义词典：把别名归一为规范词，双向扩展。
 * 形如 [别名片段, 规范词]，命中即同时加入两者，提升语义召回。
 */
const ALIASES = [
  ["恶性肿瘤", "肿瘤"],
  ["癌症", "肿瘤"],
  ["癌", "肿瘤"],
  ["瘤", "肿瘤"],
  ["化疗", "化学治疗"],
  ["放疗", "放射治疗"],
  ["放化", "放化疗"],
  ["靶向", "靶向治疗"],
  ["靶向药", "靶向治疗"],
  ["免疫", "免疫治疗"],
  ["白细胞减少", "骨髓抑制"],
  ["骨髓抑制", "白细胞减少"],
  ["血小板", "血小板减少"],
  ["贫血", "血红蛋白降低"],
  ["耐药", "药物耐药"],
  ["基因变异", "基因突变"],
  ["咳", "咳嗽"],
  ["发热", "发烧"],
  ["心梗", "心肌梗死"],
  ["脑梗", "脑梗死"],
  ["糖耐量", "糖尿病"],
  ["慢阻肺", "慢性阻塞性肺疾病"],
  ["呼衰", "呼吸衰竭"],
  ["肾衰", "肾功能衰竭"],
  ["肝衰", "肝功能衰竭"],
  ["支架", "冠状动脉支架"],
  ["搭桥", "冠状动脉旁路移植"],
  ["青霉素", "抗菌药物"],
  ["抗生素", "抗菌药物"],
  ["结节", "占位"],
  ["占位", "结节"],
  ["转移", "远处转移"],
];

/** 通用文档结构词（出现在几乎所有指南标题/关键词中，无区分度，须剔除噪声）。 */
const GENERIC = new Set([
  "指南",
  "诊疗",
  "方案",
  "规范",
  "标准",
  "技术",
  "共识",
  "专家",
  "年版",
  "版",
  "年",
  "（",
  "）",
  "(",
  ")",
  "及",
  "与",
  "和",
  "的",
  "等",
  "了",
  "是",
  "（2022",
  "（2024",
  "（2025",
  "2022年版",
  "2024年版",
  "2025年版",
]);

/** 词元化：拉丁/数字词 + CJK 单字 + CJK 二元组，并经同义词扩展；剔除通用噪声词。 */
export function tokenize(text) {
  const n = normalize(text);
  if (!n) return new Set();
  const tokens = new Set();
  for (const m of n.match(/[a-z0-9]+/g) || []) tokens.add(m);
  const cjk = n.match(/[一-鿿]+/g) || [];
  for (const w of cjk) {
    for (const ch of w) tokens.add(ch);
    for (let i = 0; i < w.length - 1; i++) tokens.add(w.slice(i, i + 2));
  }
  // 同义词双向扩展
  for (const t of [...tokens]) {
    for (const [a, b] of ALIASES) {
      if (t.includes(a)) {
        tokens.add(a);
        tokens.add(b);
      }
    }
  }
  // 剔除通用噪声词
  for (const g of GENERIC) tokens.delete(g);
  return tokens;
}

/**
 * 短语级同义词：将「器官 + 恶性肿瘤」等常见 paraphrasing 归一到规范疾病名。
 * 例如「胃部恶性肿瘤」→「胃癌」，既修正单字器官歧义，也兼容「食道/食管」异体字。
 * 在分词前对原始查询做字符串替换。
 */
const PHRASE_ALIASES = [
  ["胃部恶性肿瘤", "胃癌"],
  ["胃恶性肿瘤", "胃癌"],
  ["肝脏恶性肿瘤", "肝癌"],
  ["肝恶性肿瘤", "肝癌"],
  ["食道恶性肿瘤", "食管癌"],
  ["食管恶性肿瘤", "食管癌"],
  ["肺部恶性肿瘤", "肺癌"],
  ["乳腺恶性肿瘤", "乳腺癌"],
  ["结肠恶性肿瘤", "结肠癌"],
  ["直肠恶性肿瘤", "直肠癌"],
  ["宫颈恶性肿瘤", "宫颈癌"],
  ["膀胱恶性肿瘤", "膀胱癌"],
  ["前列腺恶性肿瘤", "前列腺癌"],
  ["卵巢恶性肿瘤", "卵巢癌"],
  ["肾脏恶性肿瘤", "肾细胞癌"],
  ["胰脏恶性肿瘤", "胰腺癌"],
  ["恶性淋巴瘤", "淋巴瘤"],
  ["子宫内膜恶性肿瘤", "子宫内膜癌"],
];

/** 对原始查询应用短语同义词归一。 */
export function applyPhraseAliases(query) {
  let q = query;
  for (const [ph, can] of PHRASE_ALIASES) {
    if (q.includes(ph)) q = q.replace(ph, can);
  }
  return q;
}

/**
 * 从查询中提取显式年份版次（如"2024版""2026年版"，「年」字可选）。
 * 命中返回数字年份，否则 null。用于用户对版本有明确诉求时的强偏好路由。
 */
export function extractYear(query) {
  const m = String(query || "").match(/(\d{4})\s*年?版/);
  return m ? Number(m[1]) : null;
}

/** 兼容全角/半角括号，从指南标题提取版本年份（「年」字可选：2024年版 / 2026版）。 */
export function versionOf(title) {
  const m = String(title || "").match(/(?:（|\()(\d{4})\s*年?版(?:）|\))/);
  return m ? Number(m[1]) : null;
}

/**
 * 构建 IDF 表：token 在越多指南中出现，区分度越低（idf 越小）。
 * 用于语义重叠加权——稀有词元（如"前列""列腺"）权重远高于高频词元（如"性""的""肿瘤"）。
 * 结果挂到 index._idf 上，避免重复计算。
 */
export function buildIdf(idx) {
  if (idx._idf) return idx._idf;
  const guideMap = idx.guideMap || {};
  const N = Math.max(1, Object.keys(guideMap).length);
  const df = new Map();
  for (const info of Object.values(guideMap)) {
    const toks = tokenize(
      [info.id || "", info.disease || "", (info.keywords || []).join(" ")].join(
        " ",
      ),
    );
    for (const t of toks) df.set(t, (df.get(t) || 0) + 1);
  }
  const idf = new Map();
  for (const [t, d] of df) idf.set(t, Math.log(N / Math.max(1, d)));
  idx._idf = idf;
  return idf;
}

/** 候选计入的最小语义加权分（配合强信号规则，过滤越界噪声）。 */
const MIN_SCORE = 4;

/**
 * 预计算每个指南的主体词元（标题+疾病，标识性最强）与次要词元（关键词表，支撑性）。
 * 语义重叠时主体词元全权、次要词元降权（W_SECONDARY），避免「在某指南关键词里顺带提及某器官」
 * 的泛癌指南（如弥漫性大B细胞淋巴瘤）盖过「该器官即为主体疾病」的专科指南（如胃癌）。
 * 结果挂到 index._gtok 上，避免重复计算。
 */
const W_SECONDARY = 0.35;
export function buildGuideTokens(idx) {
  if (idx._gtok) return idx._gtok;
  const map = new Map();
  for (const [title, info] of Object.entries(idx.guideMap || {})) {
    const primary = tokenize([info.id || "", info.disease || ""].join(" "));
    const secondary = tokenize((info.keywords || []).join(" "));
    map.set(title, { primary, secondary });
  }
  idx._gtok = map;
  return map;
}

/** Levenshtein 编辑距离（用于模糊匹配）。 */
export function lev(a, b) {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(
        d[i - 1][j] + 1,
        d[i][j - 1] + 1,
        d[i - 1][j - 1] + cost,
      );
    }
  }
  return d[m][n];
}

/** 读取指南索引（默认项目根下的 medical-knowlegde-base/.guide-index.json）。 */
export function loadIndex(baseDir = process.cwd()) {
  const p = join(baseDir, "medical-knowlegde-base", ".guide-index.json");
  return JSON.parse(readFileSync(p, "utf-8"));
}

/**
 * 路由：给定查询，返回按相关性排序的指南列表。
 * @param {string} query 用户原始查询
 * @param {object} [opts]
 * @param {object} [opts.index] 预加载的索引（避免重复读盘）
 * @param {number} [opts.topK=5] 返回数量
 * @param {boolean} [opts.useSemantic=true] 是否启用语义路由（同义/模糊）
 * @param {boolean} [opts.useCache=true] 是否启用结果缓存
 * @param {string} [opts.baseDir] 索引基目录
 * @returns {{query:string,top:Array,totalMatched:number,semantic:boolean,cached:boolean}}
 */
export function routeGuides(query, opts = {}) {
  const {
    index,
    topK = 5,
    useSemantic = true,
    useCache = true,
    baseDir,
  } = opts;
  const idx = index || loadIndex(baseDir);
  const idf = buildIdf(idx);
  const gtok = buildGuideTokens(idx);
  const qAliased = applyPhraseAliases(query);
  const qNorm = normalize(qAliased);
  const qYear = extractYear(qAliased);
  const cacheKey = `route:${qNorm}`;

  if (useCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  if (!qNorm) {
    return {
      query,
      top: [],
      totalMatched: 0,
      semantic: useSemantic,
      cached: false,
    };
  }

  const qTokens = tokenize(qAliased);
  const kwIndex = idx.keywordIndex || {};
  const guideMap = idx.guideMap || {};
  const scored = [];

  for (const [title, info] of Object.entries(guideMap)) {
    let score = 0;
    const reasons = [];

    // ① 关键词索引精确/包含匹配（沿用原逻辑，权重最高）
    const matchedKw = [];
    for (const [kw, guides] of Object.entries(kwIndex)) {
      const k = kw.toLowerCase();
      if (k === qNorm || k.includes(qNorm) || qNorm.includes(k)) {
        if (Array.isArray(guides) && guides.includes(title)) matchedKw.push(kw);
      }
    }
    if (matchedKw.length) {
      score += matchedKw.length * 5;
      reasons.push(`关键词命中:${matchedKw.slice(0, 3).join("/")}`);
    }

    // 版本/归一疾病/人群元数据（用于「最新版优先」+ 显式年份强匹配）
    const candYear = info.version ?? versionOf(title);
    const candNorm = info.normalizedDisease || info.disease || "";
    const candAud = info.audience || null;

    // ② 标题/疾病字面包含
    const titleL = title.toLowerCase();
    const disease = (info.disease || "").toLowerCase();
    if (titleL.includes(qNorm) || disease.includes(qNorm)) {
      score += 4;
      reasons.push("标题/疾病包含");
    }

    // ③ 语义层：主体/次要词元分层重叠（IDF 加权）+ 模糊
    if (useSemantic) {
      const toks = gtok.get(title) || {
        primary: new Set(),
        secondary: new Set(),
      };
      const hitTokens = [];
      let semScore = 0;
      for (const t of qTokens) {
        // 仅统计语料库中存在的词元：OOV 词元（如"番茄""炒蛋"）对定位无贡献，忽略之。
        if (!idf.has(t)) continue;
        let w = 0;
        if (toks.primary.has(t))
          w = 1; // 主体词元全权
        else if (toks.secondary.has(t)) w = W_SECONDARY; // 次要词元降权
        if (w > 0) {
          semScore += w * (1 + (idf.get(t) || 0)); // 稀有词元权重更高
          if (hitTokens.length < 5) hitTokens.push(t);
        }
      }
      if (semScore > 0) {
        score += semScore;
        reasons.push(
          `语义重叠(IDF加权)${semScore.toFixed(1)}(${hitTokens.join("/")})`,
        );
      }
      // 模糊：未命中的长词元（≥3，且在语料库内）与指南主体词元距离=1
      let fuzzy = 0;
      const qtokensLong = [...qTokens].filter(
        (t) => t.length >= 3 && idf.has(t),
      );
      for (const qt of qtokensLong) {
        for (const gt of toks.primary) {
          if (gt.length >= 3 && lev(qt, gt) === 1) {
            fuzzy++;
            break;
          }
        }
      }
      if (fuzzy) {
        score += fuzzy;
        reasons.push(`模糊匹配×${fuzzy}`);
      }
    }

    // ③·补 显式年份强匹配：用户明确要某年版时，命中该年版则强偏好，否则降级
    if (qYear != null && candYear != null) {
      if (candYear === qYear) {
        score += 12;
        reasons.push(`年份精确匹配${qYear}`);
      } else {
        score -= 3;
        reasons.push(`年份不符(查${qYear}/文${candYear})`);
      }
    }

    // 仅当具备实质性信号（关键词/标题命中，或语义加权分达标）才计入候选，
    // 避免越界查询因若干高频词元噪声被误召回。
    const hasStrong =
      matchedKw.length > 0 ||
      titleL.includes(qNorm) ||
      disease.includes(qNorm) ||
      score >= MIN_SCORE;
    // 显式年份硬约束：用户明确要某年版时，仅保留该年版候选
    // （同行若无匹配则 totalMatched=0，由越界/澄清逻辑接管，优于误推他版）。
    if (qYear != null && candYear != null && candYear !== qYear) {
      continue;
    }
    if (score > 0 && hasStrong) {
      const deprecated = info.deprecated === true;
      scored.push({
        title,
        id: info.id || title,
        disease: info.disease || "",
        version: candYear,
        normalizedDisease: candNorm,
        audience: candAud,
        deprecated,
        sectionCount: info.sectionCount ?? null,
        keyParagraphCount: info.keyParagraphCount ?? null,
        score,
        reasons,
        matchedKeywords: matchedKw,
      });
    }
  }

  scored.sort((a, b) => {
    // 废弃标记软降权：已废止指南降分处理（非硬排序），确保显式年份查询仍可定位旧版
    const aScore = a.score - ((a.deprecated && a.version != null) ? 10 : 0);
    const bScore = b.score - ((b.deprecated && b.version != null) ? 10 : 0);
    if (bScore !== aScore) return bScore - aScore;
    // 同名归一 + 同人群 = 同一指南的不同年版：医疗上现行「最新版」优先（旧版或已废止）
    const an = a.normalizedDisease || "";
    const bn = b.normalizedDisease || "";
    if (an && an === bn && (a.audience || null) === (b.audience || null)) {
      const av = a.version || 0;
      const bv = b.version || 0;
      if (av !== bv) return bv - av; // 新版在前
    }
    if (b.score !== a.score) return b.score - a.score;
    const aE =
      a.title.toLowerCase().includes(qNorm) ||
      a.disease.toLowerCase().includes(qNorm)
        ? 0
        : 1;
    const bE =
      b.title.toLowerCase().includes(qNorm) ||
      b.disease.toLowerCase().includes(qNorm)
        ? 0
        : 1;
    return aE - bE;
  });

  const top = scored.slice(0, topK);
  const result = {
    query,
    top,
    totalMatched: scored.length,
    semantic: useSemantic,
    cached: false,
  };
  if (useCache) cacheSet(cacheKey, result);
  return result;
}
