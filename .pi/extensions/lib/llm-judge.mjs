// llm-judge.mjs — 兼容入口
//
// 答案质量 LLM-Judge（四维）+ 免费优先 LLM 客户端。
// 原单文件已按职责拆分为：
//   llm-judge/client.mjs — LLM 客户端 + 并发执行器
//   llm-judge/judge.mjs  — 四维评审

export { SENSENOVA_CONCURRENCY, isLLMAvailable, availableKeyCount, callLLM, runWithConcurrency, checkKeyHealth } from "./llm-judge/client.mjs";
export { JUDGE_DIMENSIONS, buildJudgeMessages, judgeAnswer } from "./llm-judge/judge.mjs";
