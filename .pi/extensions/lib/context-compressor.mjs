// context-compressor.mjs
// 多轮对话上下文压缩 —— 滑动窗口 + 摘要压缩 + token 预算管理。
//
// 三层上下文架构：
//   L1（核心，≤8k tokens）：当前轮检索结果 + 最新 2 轮问答
//   L2（摘要，≤2k tokens）：前序 N 轮的 LLM 生成摘要（增量更新）
//   L3（状态，≤1k tokens）：slot 值（主诉、人群等 —— 由 conversation-state 维护）
//
// 设计要点：
//   1. 纯 .mjs，可被 .ts 扩展（jiti）和原生 node 共同加载
//   2. LLM 生成为可选（无 API Key 时退化为纯滑动窗口裁剪）
//   3. 摘要缓存：同一次会话中，同一轮历史不再重复摘要
//   4. 预算超限时按优先级裁剪：L3 > L2 > L1 截断
//
// 用法:
//   import { compressConversation } from "./lib/context-compressor.mjs";
//   const compressed = await compressConversation(messages, { maxTokens: 12000 });

// ── token 估算（中文字符≈1.5 token，英文≈0.3 token，粗略）──
function estimateTokens(text) {
  if (!text) return 0;
  let tokens = 0;
  for (const ch of text) {
    tokens += (ch.charCodeAt(0) > 0x7f) ? 1.5 : 0.3;
  }
  return Math.ceil(tokens);
}

// ── 摘要缓存（进程内 Map，防重复生成）──
// key: "turnHash" = md5-like short hash of conversation turn text
const summaryCache = new Map();

// ── 默认预算配置 ──
const DEFAULTS = {
  totalBudget: 12000,       // 总 token 预算
  l1Budget: 8000,           // L1 核心预算
  l2Budget: 2000,           // L2 摘要预算
  l3Budget: 1000,           // L3 状态预算
  l3MinBudget: 300,         // L3 状态最低保留（强制保底）
  fullTurns: 2,             // 保留完整轮数
  summaryTurns: 8,          // 最多摘要轮数（超出则丢弃最旧）
  summaryTimeoutMs: 3000,   // LLM 摘要生成超时
};

/**
 * 对一段对话轮次生成摘要。
 * 调用 sensenova 免费模型，超时 3s 降级为原始文本截断。
 *
 * @param {Array} turns 对话轮次数组，每项 { role, content }
 * @param {object} [opts]
 * @returns {Promise<string>} 摘要文本
 */
async function summarizeTurns(turns, opts = {}) {
  const { summaryTimeoutMs = 3000 } = opts;
  if (!Array.isArray(turns) || turns.length === 0) return "";

  // 生成缓存 key
  const rawText = turns.map((t) => `${t.role}: ${typeof t.content === "string" ? t.content.slice(0, 100) : ""}`).join("|");
  const cacheKey = rawText.length > 5 ? rawText.slice(0, 200) : rawText;
  const cached = summaryCache.get(cacheKey);
  if (cached) return cached;

  // 尝试 LLM 摘要
  try {
    const { callLLM, isLLMAvailable } = await import("./llm-judge.mjs");
    if (!isLLMAvailable || !isLLMAvailable()) throw new Error("LLM 不可用");

    const turnText = turns
      .map((t) => `${t.role === "user" ? "用户" : "助手"}: ${typeof t.content === "string" ? t.content : JSON.stringify(t.content)}`)
      .join("\n---\n")
      .slice(0, 2000); // 防止输入过长

    const summary = await callLLM([
      {
        role: "system",
        content: [
          "你是一个多轮对话摘要器。将以下医学咨询对话轮次压缩为一段紧凑摘要，要求：",
          "1) 保留用户的主诉、疾病名称、关键症状、用药史",
          "2) 保留已提供的循证医学结论（药物名称、剂量范围）",
          "3) 保留未解决的问题或待确认事项",
          "4) 长度控制在 100-200 字",
          "5) 只输出摘要文本，不要其他格式",
        ].join("\n"),
      },
      { role: "user", content: `对话记录：\n${turnText}` },
    ], { temperature: 0.1, maxTokens: 300, timeoutMs: summaryTimeoutMs });

    const result = (summary || "").trim();
    if (result && result.length > 20) {
      summaryCache.set(cacheKey, result);
      return result;
    }
  } catch {
    // 降级：截断拼接
  }

  // 降级：取最后几条消息的关键句拼接
  const fallback = turns
    .slice(-3)
    .map((t) => {
      const text = typeof t.content === "string" ? t.content.slice(0, 120) : "";
      return `${t.role}: ${text}`;
    })
    .join(" | ");
  if (fallback.length > 10) {
    summaryCache.set(cacheKey, fallback);
    return fallback;
  }
  return "";
}

/**
 * 从消息列表中提取"轮次"结构。
 * 一条用户消息 + 后续的 assistant 消息 = 一轮。
 *
 * @param {Array} messages 原始 messages 数组 [{role, content}, ...]
 * @returns {Array<Array>} 按轮分组，每轮为消息数组
 */
function groupIntoRounds(messages) {
  if (!Array.isArray(messages) || messages.length === 0) return [];
  const rounds = [];
  let currentRound = [];
  let waitingForAssistant = false;
  for (const msg of messages) {
    if (msg.role === "user") {
      if (currentRound.length > 0 && !waitingForAssistant) {
        // 连续用户消息视为同一轮的不同部分
        currentRound.push(msg);
      } else {
        if (currentRound.length > 0) rounds.push(currentRound);
        currentRound = [msg];
        waitingForAssistant = true;
      }
    } else if (msg.role === "assistant" || msg.role === "system") {
      if (currentRound.length > 0) {
        currentRound.push(msg);
        waitingForAssistant = false;
      }
    }
  }
  if (currentRound.length > 0) rounds.push(currentRound);
  return rounds;
}

/**
 * 核心上下文压缩函数。
 *
 * @param {Array} messages 完整消息历史（[{role, content}, ...]）
 * @param {object} [opts]
 * @param {number} [opts.totalBudget=12000] 总 token 预算
 * @param {string} [opts.stateContext=""] L3 状态文本（由 conversation-state 提供）
 * @returns {Promise<{messages: Array, compressed: boolean, stats: object}>}
 *   - messages: 压缩后的消息数组（可用于替换原 history）
 *   - compressed: 是否执行了压缩
 *   - stats: 压缩统计（beforeTokens, afterTokens, summaryRounds）
 */
export async function compressConversation(messages, opts = {}) {
  const config = { ...DEFAULTS, ...opts };
  const { totalBudget, fullTurns, summaryTurns } = config;

  if (!Array.isArray(messages) || messages.length === 0) {
    return { messages: messages || [], compressed: false, stats: null };
  }

  // token 估算
  const fullText = messages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  const beforeTokens = estimateTokens(fullText);

  // 预算足够 → 不压缩（留 10% 余量）
  if (beforeTokens <= totalBudget * 0.9) {
    return { messages, compressed: false, stats: { beforeTokens, afterTokens: beforeTokens, action: "skip" } };
  }

  // 分组轮次
  const rounds = groupIntoRounds(messages);
  if (rounds.length <= fullTurns + 1) {
    // 轮次太少，只做简单裁剪
    const kept = rounds.slice(-(fullTurns + 1)).flat();
    const afterText = kept.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
    const afterTokens = estimateTokens(afterText);
    return { messages: kept, compressed: true, stats: { beforeTokens, afterTokens, action: "trim" } };
  }

  // 保留最后 fullTurns 轮的完整内容（L1）
  const recentRounds = rounds.slice(-fullTurns);
  const recentMessages = recentRounds.flat();

  // 前序轮次需要压缩（L2）
  const oldRounds = rounds.slice(0, -fullTurns);
  const oldMessages = oldRounds.flat();

  // 状态上下文（L3）
  const stateContext = opts.stateContext || "";
  const stateTokens = estimateTokens(stateContext);
  const recentTokens = estimateTokens(
    recentMessages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n")
  );

  // 预算分配检查
  const budgetForL2 = Math.max(500, totalBudget - recentTokens - Math.min(stateTokens, config.l3Budget));
  let l2Text = "";
  let summaryRounds = 0;

  if (oldRounds.length > 0 && budgetForL2 > 200) {
    // 如果前序轮次太多，只保留最近的 summaryTurns 轮做摘要
    const roundsToSummarize = oldRounds.slice(-summaryTurns);
    summaryRounds = roundsToSummarize.length;

    // 尝试 LLM 摘要
    l2Text = await summarizeTurns(roundsToSummarize.flat(), config);
    if (!l2Text || l2Text.length < 20) {
      // LLM 摘要失败，简单截取历史最后几条的要点
      const lastMsgs = roundsToSummarize.flat().slice(-6);
      l2Text = lastMsgs
        .map((m) => {
          const text = typeof m.content === "string" ? m.content.slice(0, 80) : "";
          return text;
        })
        .filter(Boolean)
        .join("\n")
        .slice(0, 500);
    }

    // 控制 L2 预算
    const l2Tokens = estimateTokens(l2Text);
    if (l2Tokens > budgetForL2) {
      // 超额：截断
      const ratio = budgetForL2 / l2Tokens;
      const maxChars = Math.floor(l2Text.length * ratio);
      l2Text = l2Text.slice(0, maxChars) + "…（截断）";
    }
  }

  // 组装压缩后的消息数组
  const compressedMessages = [];

  // L2：历史摘要（以 system 消息形式注入，不占用户轮次）
  if (l2Text && l2Text.length > 20) {
    compressedMessages.push({
      role: "system",
      content: `[前序对话摘要]\n${l2Text}\n[以下为最新对话]`,
    });
  }

  // L1：最新 fullTurns 轮的完整内容
  for (const msg of recentMessages) {
    compressedMessages.push(msg);
  }

  const afterText = compressedMessages.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  const afterTokens = estimateTokens(afterText);

  return {
    messages: compressedMessages,
    compressed: true,
    stats: {
      beforeTokens,
      afterTokens,
      savedTokens: beforeTokens - afterTokens,
      compressionRatio: beforeTokens > 0 ? (1 - afterTokens / beforeTokens) * 100 : 0,
      summaryRounds,
      action: "compressed",
    },
  };
}

/**
 * 快捷 token 估算导出（供外部使用）。
 */
export { estimateTokens };
