// feedback-loop.mjs — 兼容入口
//
// 维度五·持续反馈优化。原单文件已拆分为：
//   feedback-loop/signal.mjs    — 信号采集
//   feedback-loop/aggregate.mjs — 热点聚合 + 建议生成
//   feedback-loop/queue.mjs     — 队列构建/读写/解决管理
//   feedback-loop/merge.mjs     — Gold 派生 + 消费 + 受控并入

export { SEVERITY, collectSignals } from "./feedback-loop/signal.mjs";
export { aggregateHotspots, buildSuggestions } from "./feedback-loop/aggregate.mjs";
export { buildFeedbackQueue, writeFeedbackQueue, readFeedbackQueue, loadResolved, resolveFeedback } from "./feedback-loop/queue.mjs";
export { deriveGoldCandidates, consumeFeedback, writeConsumed, mergeIntoGold } from "./feedback-loop/merge.mjs";
