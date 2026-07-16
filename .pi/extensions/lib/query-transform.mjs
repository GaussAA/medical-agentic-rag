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
