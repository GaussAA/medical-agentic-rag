// query-sanitize.mjs
// 检索查询输入脱敏 + CRAG 医疗查询纠错
// 在查询进入向量库/BM25 检索与 telemetry 埋点前：
//   1) 强制剥离手机号/身份证/邮箱等 PII（合规红线）
//   2) 医疗纠错：同音字纠正、缩写扩展、术语补全（CRAG 策略）
// 纯 .mjs，双可测（jiti + 原生 node）。
//
// CRAG（Corrective RAG）限定：仅做通用错别字/同音字/缩写扩展/不完整术语补全，
// 不做"症状→疾病"的解释性修正（如不将"肚子疼"改写为"胃炎"），严守安全底线。

import { maskPII } from "./phi-crypto.mjs";

// ---- CRAG 数据：医学同音字纠正（常见于患者提问输入）----
// 格式：错误字 → 最可能的正确字
const HOMOPHONE_MAP = {
  "胃": "胃", "位": "胃",
  "肺": "肺", "废": "肺",
  "肝": "肝", "干": "肝",
  "肾": "肾", "慎": "肾",
  "糖": "糖", "唐": "糖",
  "压": "压", "丫": "压",
  "瘤": "瘤", "留": "瘤",
  "癌": "癌", "挨": "癌", "哀": "癌",
  "药": "药", "要": "药",
  "痛": "痛", "通": "痛",
  "咳": "咳", "刻": "咳",
  "烧": "烧", "稍": "烧",
  "痒": "痒", "养": "痒",
  "肿": "肿", "中": "肿",
  "胀": "胀", "账": "胀",
  "呕": "呕", "欧": "呕",
  "吐": "吐", "兔": "吐",
  "泻": "泻", "谢": "泻",
  "痣": "痣", "志": "痣",
  "痔": "痔",
  "斑": "斑", "般": "斑",
  "疹": "疹", "珍": "疹",
  "疤": "疤", "巴": "疤",
};

// 医学术语缩写 → 完整形式
const ABBREVIATIONS = {
  "copd": "慢性阻塞性肺疾病",
  "dm": "糖尿病",
  "t2dm": "2型糖尿病",
  "htn": "高血压",
  "cvd": "心血管疾病",
  "chd": "冠心病",
  "cad": "冠状动脉疾病",
  "ami": "急性心肌梗死",
  "mi": "心肌梗死",
  "ckd": "慢性肾脏病",
  "ibd": "炎症性肠病",
  "ra": "类风湿关节炎",
  "sle": "系统性红斑狼疮",
  "tb": "肺结核",
  "hiv": "艾滋病",
  "aids": "艾滋病",
  "af": "房颤",
  "pe": "肺栓塞",
  "dvt": "深静脉血栓",
  "tia": "短暂性脑缺血发作",
  "bp": "血压",
  "bmi": "体重指数",
  "ecg": "心电图",
  "eeg": "脑电图",
  "mri": "核磁共振",
  "ct": "CT检查",
  "ultrasound": "超声检查",
};

// 不完整医学术语补全：短前缀 → 完整术语
// 仅做确定性补全（唯一匹配），不做有歧义的自动补全
const INCOMPLETE_TERMS = [
  ["高血", "高血压"],
  ["低血", "低血压"],
  ["糖尿", "糖尿病"],
  ["冠心", "冠心病"],
  ["脑梗", "脑梗死"],
  ["心梗", "心肌梗死"],
  ["慢阻", "慢阻肺"],
  ["脂肪", "脂肪肝"],
  ["肝硬", "肝硬化"],
  ["肾衰", "肾衰竭"],
  ["心衰", "心力衰竭"],
  ["心律", "心律失常"],
  ["心律失", "心律失常"],
  ["骨质疏", "骨质疏松"],
  ["骨质增生", "骨质增生"],
  ["关节", "关节炎"],
  ["前列", "前列腺"],
  ["胃溃", "胃溃疡"],
  ["十二", "十二指肠"],
  ["脑出", "脑出血"],
  ["脑卒", "脑卒中"],
  ["心力衰", "心力衰竭"],
];

/**
 * 医疗查询纠错（CRAG 策略）。
 * 限定范围：
 *   - 同音字纠正：仅替换常见的医学同音/近音别字
 *   - 缩写扩展：英文缩写 → 中文术语（大小写不敏感）
 *   - 不完整术语补全：短前缀 → 完整术语（仅做确定性一对一映射）
 * 不做"症状→疾病"的解释性修正。
 * @param {string} query 原始查询串（不应当为 null/空串）
 * @returns {string} 纠错后的查询串
 */
export function correctMedicalQuery(query) {
  if (!query) return query;
  let s = String(query);

  // 1) 同音字纠正（逐字符替换，避免文本过长时的性能问题；医疗查询通常<200 字）
  const chars = [...s];
  let changed = false;
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i];
    const mapped = HOMOPHONE_MAP[c];
    if (mapped && mapped !== c) {
      chars[i] = mapped;
      changed = true;
    }
  }
  if (changed) s = chars.join("");

  // 2) 不完整术语补全（在完整的词汇边界替换，以免切割已有正确词）
  //    策略：对每个前缀依次尝试 endsWith → startsWith（后跟非汉字）→ 词边界正则
  //    从最长前缀开始匹配，避免短前缀提前截胡。
  const sortedIncomplete = [...INCOMPLETE_TERMS].sort((a, b) => b[0].length - a[0].length);
  const hanTest = /[\u4e00-\u9fff]/;
  for (const [prefix, full] of sortedIncomplete) {
    let changed = false;
    // 2a) 句末补全（最常见的不完整输入：用户未打完即提交）
    if (s.endsWith(prefix)) {
      s = s.slice(0, -prefix.length) + full;
      changed = true;
    }
    // 2b) 句首补全（"高血怎么办" → "高血压怎么办"），仅当前缀后面不是汉字时
    if (!changed && s.startsWith(prefix) && s.length > prefix.length && !hanTest.test(s[prefix.length])) {
      s = full + s.slice(prefix.length);
      changed = true;
    }
    // 2c) 词边界补全（"xx 高血 yy" → "xx 高血压 yy"，前后是非汉字）
    if (!changed) {
      const re = new RegExp(`(?:^|[^\\u4e00-\\u9fff])${escapeRegex(prefix)}(?=$|[^\\u4e00-\\u9fff])`, "g");
      s = s.replace(re, (match) => {
        // 保留前缀前的分隔符字符（非汉字）
        const pre = match.length > prefix.length ? match[0] : "";
        return pre + full;
      });
    }
  }

  // 3) 缩写扩展（大小写不敏感，独立词——前是非字母数字 或 开头；后是非字母数字 或 结尾）
  for (const [abbr, full] of Object.entries(ABBREVIATIONS)) {
    const re = new RegExp(`(?<=^|[^a-zA-Z0-9])${escapeRegex(abbr)}(?=$|[^a-zA-Z0-9])`, "gi");
    s = s.replace(re, full);
  }

  return s;
}

/** 转义正则特殊字符 */
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 对检索查询做安全净化：脱敏 PII + 去空白 + 兜底空串。
 * 医疗领域词（如「患者65岁」「血压120」）不被误伤（maskPII 仅匹配高置信 PII 模式）。
 * @param {unknown} q 原始查询（可能来自 LLM 参数，类型不定）
 * @returns {string} 已脱敏的查询串
 */
export function sanitizeSearchQuery(q) {
  if (q == null) return "";
  const s = String(q).trim();
  if (!s) return "";
  return maskPII(s);
}

/** 对自由文本（如 telemetry、日志）做同样的 PII 脱敏后返回。 */
export function sanitizeForLog(text) {
  if (text == null) return text;
  return maskPII(String(text));
}
