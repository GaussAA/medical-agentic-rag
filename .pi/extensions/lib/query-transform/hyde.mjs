// hyde.mjs
// HyDE (Hypothetical Document Embedding) 假设文档扩展。
//
// 思路：用 LLM 生成一段假设性的答案文本（hypothetical answer），
// 再以该文本作为检索查询，获取更多相关段落。
// 假设答案比原始查询包含更多医学术语，在 BM25 空间中有更好的召回表现。
//
// 流程：
//   原始查询 → BM25 → 结果A
//   原始查询 → LLM → 假设答案 → BM25 → 结果B
//   RRF 融合 结果A + 结果B → 最终结果
//
// 纯项目层扩展，pi-knowledge 无感知。

import { callLLM, isLLMAvailable } from "../llm-judge.mjs";
import { diag } from "../diagnostic-log.mjs";

/**
 * 构建 HyDE 生成 prompt。
 * 要求 LLM 输出一段假设性的、能回答该问题的医学文本段落。
 * @param {string} query
 * @returns {Array}
 */
function buildHydePrompt(query) {
  return [
    {
      role: "system",
      content: [
        "你是一个医学知识库生成器。根据用户的医学问题，生成一段假设性的知识文本段落。",
        "要求：",
        "1) 段落应像从医学指南中摘录的内容——使用标准医学术语、客观陈述、不带评价",
        "2) 如果涉及诊断/治疗，引用已知的医学共识（不编造具体数值/剂量）",
        "3) 长度控制在 100-200 字，保持紧凑",
        "4) 只输出纯文本段落，不要序号、不要提示词、不要格式",
        "5) 如果问题非医学相关，只输出空行",
      ].join("\n"),
    },
    { role: "user", content: query },
  ];
}

/**
 * 使用 LLM 生成假设答案文本。
 * @param {string} query 原始查询
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs=5000]  LLM 超时
 * @returns {Promise<string|null>} 假设答案文本，失败返回 null
 */
export async function generateHypotheticalAnswer(query, opts = {}) {
  const { timeoutMs = 5000 } = opts;
  if (!query || !query.trim()) return null;
  if (!isLLMAvailable()) return null;

  try {
    const text = await callLLM(buildHydePrompt(query), {
      temperature: 0.1,
      maxTokens: 300,
      timeoutMs,
    });
    const result = (text || "").trim();
    if (!result || result.length < 20) return null; // 太短说明 LLM 无法生成有用内容
    diag.info("hyde", `生成假设答案 (${result.length} 字符): "${result.slice(0, 60)}..."`);
    return result;
  } catch (e) {
    diag.warn("hyde", `生成失败，跳过 HyDE: ${e?.message || e}`);
    return null;
  }
}

/**
 * HyDE 检索管道：原始查询检索 + 假设答案检索 → RRF 融合。
 *
 * @param {string} query         原始查询
 * @param {Function} searchFn    检索函数，签名 (query, opts) => { results: [...] }
 * @param {object} [opts]
 * @param {number} [opts.limit=100]  每路检索条数
 * @param {number} [opts.rrfK=60]    RRF 融合常数
 * @param {number} [opts.hydeTimeoutMs=5000]  HyDE LLM 超时
 * @returns {Promise<{ results: Array, hydeApplied: boolean, hydeQuery: string|null }>}
 */
export async function hydeRetrieve(query, searchFn, opts = {}) {
  const { limit = 100, rrfK = 60, hydeTimeoutMs = 5000 } = opts;

  // 原始检索
  const original = searchFn(query, { limit });
  const originalResults = original?.results || [];

  // 生成假设答案
  const hydeText = await generateHypotheticalAnswer(query, { timeoutMs: hydeTimeoutMs });
  if (!hydeText) {
    return { results: originalResults, hydeApplied: false, hydeQuery: null };
  }

  // 用假设答案检索
  const hydeResult = searchFn(hydeText, { limit });
  const hydeResults = hydeResult?.results || [];

  if (hydeResults.length === 0) {
    return { results: originalResults, hydeApplied: true, hydeQuery: hydeText };
  }

  // RRF 融合
  const { rrfFusion } = await import("../retrieval-router.mjs");
  const fused = rrfFusion([originalResults, hydeResults], rrfK, limit);

  diag.info("hyde", `HyDE 融合: 原始 ${originalResults.length} 条 + HyDE ${hydeResults.length} 条 → ${fused.length} 条`);

  return { results: fused, hydeApplied: true, hydeQuery: hydeText };
}
