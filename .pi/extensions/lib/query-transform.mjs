// query-transform.mjs
// 医疗查询改写（Query Transformation）
// 生成语义等价的医学查询变体，提升低质量/口语化输入的检索召回。
//
// 策略：
//   1) 复用 llm-judge 的 callLLM（免费 sensenova 优先，deepseek 兜底）
//   2) 生成 2-3 个医学等价问法变体（口语→术语、症状→疾病、笼统→具体）
//   3) 安全护栏：仅做"医学措辞改述"，不做"症状→疾病"的推断性改写
//      （如"头痛发热"可改写为"头痛 发热 症状"，不应改写为"感冒 流感"）
//
// 纯 .mjs，双可测（jiti + 原生 node）。

import { callLLM, isLLMAvailable } from "./llm-judge.mjs";
import { diag } from "./diagnostic-log.mjs";

/**
 * 构建查询改写 prompt。
 * 约束 LLM 生成 2-3 个变体，每行一个，不做诊断推断。
 * @param {string} query 原始查询
 * @returns {string} LLM system prompt + user message
 */
function buildTransformPrompt(query) {
  return [
    { role: "system", content: "你是医疗 RAG 系统的查询改写器。将用户的医疗相关查询改述为 2-3 个语义等价的检索查询，每个一行。要求：1) 保留原意，不做诊断推断；2) 可将口语转为标准医学术语（如'拉肚子'→'腹泻'）；3) 可将笼统描述拆分为关键词组合；4) 每行一个变体，不要序号；5) 若查询与医疗无关，只输出原句。不要输出其他内容。" },
    { role: "user", content: `查询：${query}` },
  ];
}

/**
 * 生成医疗查询变体。
 * 对患者口语化/不精确输入，生成 2-3 个医学等价问法，供多路检索后融合。
 *
 * @param {string} query 原始查询
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=10000]  LLM 调用超时（毫秒）
 * @returns {Promise<string[]>} 查询变体数组，至少包含原句
 */
export async function generateQueryVariants(query, opts = {}) {
  const { timeoutMs = 10000 } = opts;
  if (!query || !query.trim()) return [query || ""];

  // LLM 不可用时，回退仅原句（静默降级，不阻塞检索）
  if (!isLLMAvailable()) {
    diag.info("query-transform", "LLM 不可用，跳过查询改写（仅返回原句）");
    return [query];
  }

  try {
    const text = await callLLM(buildTransformPrompt(query), {
      temperature: 0.1,
      maxTokens: 512,
      timeoutMs,
    });
    if (!text || !text.trim()) return [query];

    // 解析 LLM 输出：按行拆分，去空，去噪
    const variants = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l.length > 2 && !/^\d+[\.\、\．]/.test(l))
      .filter((l) => l !== query);

    // 去重，最多 3 个变体 + 原句
    const seen = new Set([query]);
    const result = [query];
    for (const v of variants) {
      if (seen.has(v)) continue;
      if (v.length > 100) continue; // 太长可能 LLM 跑题，丢弃
      seen.add(v);
      result.push(v);
      if (result.length >= 4) break; // 1 原句 + 3 变体
    }

    diag.info("query-transform", `改写结果: ${result.length} 个变体`);
    // 调试级日志：输出变体（长度限制防 PII 泄露）
    if (result.length > 1) {
      diag.info("query-transform", `变体: ${result.slice(1).map((v) => v.slice(0, 40)).join(" | ")}`);
    }

    return result;
  } catch (e) {
    diag.warn("query-transform", `改写失败，回退原句: ${e?.message || e}`);
    return [query];
  }
}

/**
 * 对改写变体做质量过滤（防止 LLM 输出有害/跑题的变体）。
 * 标准：变体不能与原句语义矛盾，不能包含诊断结论。
 * 当前实现：简单长度/去重过滤，后续可复用 safety 模块做语义校验。
 * @param {string[]} variants  从 generateQueryVariants 返回的数组
 * @returns {string[]} 过滤后的安全变体数组
 */
export function filterVariants(variants) {
  if (!Array.isArray(variants) || variants.length === 0) return [];
  const original = variants[0];
  return variants.filter((v, i) => {
    if (i === 0) return true; // 保留原句
    if (!v || v.length < 3 || v.length > 100) return false;
    if (v === original) return false;
    return true;
  });
}

// ══════════════════════════════════════════════════════════
// 查询分解（原 retrieval.query-decomposer 的启发式逻辑，迁移至此
// 消除概念重叠。query-decomposer.ts 只需薄封装调用本函数。）
// ══════════════════════════════════════════════════════════

const MEDICAL_ASPECTS_RE = /(病因|发病机制|危险因素|症状|体征|诊断|筛查|检查|分期|治疗|用药|药物|手术|放疗|化疗|预后|预防|随访|康复)/g;
const STANDARD_ASPECTS = [
  { label: "定义与病因", keywords: "定义 病因 危险因素" },
  { label: "诊断方法", keywords: "诊断 筛查 检查 分期" },
  { label: "治疗方案", keywords: "治疗 药物 手术 放疗 化疗" },
  { label: "预后与预防", keywords: "预后 预防 随访 康复" },
];

/**
 * 将复杂医学问题拆解为子查询序列。
 * 纯启发式（无 LLM 依赖），支持对比类和综合类问题。
 *
 * @param {string} question 用户的原始复杂问题
 * @returns {{ type: string, subQueries: Array<{step:number, subQuery:string, targetGuide:string, searchMode:string, keywords?:string}>, lines: string[] }}
 */
export function decomposeQuery(question) {
  const subQueries = [];
  const lines = [`原始问题: ${question}\n`];
  const hasCompare = /比较|对比|差异|区别|不同|哪个更好|vs|versus/i.test(question);
  const aspectCount = (question.match(MEDICAL_ASPECTS_RE) || []).length;
  const hasMultiAspect = /以及|包括|同时|综合|全面|概览|概述|各方面|相关情况/.test(question) || aspectCount >= 2;

  if (hasCompare) {
    lines.push("问题类型: 对比类\n分解策略: 分别查询各对象后对比\n");
    const subjects = question.replace(/比较|对比|差异|区别|vs|versus/g, " ").split(/和|与|、|及/).map((s) => s.trim()).filter((s) => s.length > 1);
    if (subjects.length >= 2) {
      for (let i = 0; i < Math.min(subjects.length, 3); i++) {
        subQueries.push({ step: i + 1, subQuery: `${subjects[i]}的治疗方案和诊断方法`, targetGuide: `搜索: "${subjects[i]}"`, searchMode: "deep" });
      }
      subQueries.push({ step: subQueries.length + 1, subQuery: `对比${subjects[0]}和${subjects[1]}的异同`, targetGuide: "融合多份指南结果", searchMode: "adaptive" });
    } else {
      for (const a of ["治疗方案", "诊断方法", "预后情况"]) {
        subQueries.push({ step: subQueries.length + 1, subQuery: `${question} - ${a}`, targetGuide: "待定位", searchMode: "hybrid" });
      }
    }
  } else {
    lines.push("问题类型: 综合类\n分解策略: 按维度拆解\n");
    for (const a of STANDARD_ASPECTS) {
      subQueries.push({ step: subQueries.length + 1, subQuery: `${question} 的${a.label}`, targetGuide: "待定位", searchMode: "hybrid", keywords: a.keywords });
    }
  }

  lines.push(`分解为 ${subQueries.length} 个子查询:\n`);
  for (const sq of subQueries) {
    lines.push(`  [步骤${sq.step}] ${sq.subQuery}\n          目标: ${sq.targetGuide}\n          模式: ${sq.searchMode}\n`);
  }
  lines.push("执行建议:\n1. 对每个子查询调 retrieve 工具搜索\n2. 汇总结果给出综合性回答");
  if (hasCompare) lines.push("3. 最后对比分析异同，用表格呈现差异");

  return { type: hasCompare ? "compare" : "comprehensive", subQueries, lines };
}
