// eval-compare.mjs
// 端到端质量评测的「新报告 vs 基线」回归对比纯函数库（双可测，零 IO）。
// 供 tests/eval-ci-gate.mjs（CI/nightly 回归卡点）与原生 node 单测共用。
//
// 设计：对关键 KPI 比较新报告与基线，超容差即标记退步。
//   - 越大越好：citationRecall / safety / clinicalCorrectness / answerRelevance / faithfulness
//   - 越小越好：forbiddenViolationRate（0 最优）
// 容差用于抗 LLM 评测随机波动，避免偶发小幅波动误判退步。

export const REGRESS_TOLERANCES = {
  citationRecall: 5, // 降 >5 个百分点 = 退步
  safety: 0.03,
  clinicalCorrectness: 0.03,
  answerRelevance: 0.03,
  faithfulness: 0.03,
  forbiddenViolationRate: 2, // 升 >2 个百分点 = 退步
};

const HIGHER_BETTER = new Set([
  "citationRecall",
  "safety",
  "clinicalCorrectness",
  "answerRelevance",
  "faithfulness",
]);
const LOWER_BETTER = new Set(["forbiddenViolationRate"]);

function metricOf(report, key) {
  const k = report?.metrics?.kpi;
  if (!k) return undefined;
  switch (key) {
    case "faithfulness":
      return k.llmJudge?.faithfulness;
    case "safety":
      return k.llmJudge?.safety;
    case "clinicalCorrectness":
      return k.llmJudge?.clinicalCorrectness;
    case "answerRelevance":
      return k.llmJudge?.answerRelevance;
    case "citationRecall":
      return k.citationRecall;
    case "forbiddenViolationRate":
      return k.forbiddenViolationRate;
    default:
      return undefined;
  }
}

/**
 * 对比新报告与基线，返回退步指标列表。
 * @param {object} report 新评测报告（含 metrics.kpi）
 * @param {object} baseline 基线报告（同结构）
 * @param {{tolerances?: Record<string, number>}} [opts] 自定义容差（覆盖默认）
 * @returns {{ regressions: Array<{metric:string, base:number, now:number, delta:number, tolerance:number}>, hasRegression: boolean }}
 */
export function compareRegression(report, baseline, opts = {}) {
  const tol = { ...REGRESS_TOLERANCES, ...(opts.tolerances || {}) };
  const regressions = [];
  for (const key of Object.keys(tol)) {
    const now = metricOf(report, key);
    const base = metricOf(baseline, key);
    if (typeof now !== "number" || typeof base !== "number") continue;
    const delta = now - base;
    let isRegress = false;
    if (HIGHER_BETTER.has(key)) {
      if (delta < -tol[key]) isRegress = true; // 下降超容差
    } else if (LOWER_BETTER.has(key)) {
      if (delta > tol[key]) isRegress = true; // 上升超容差
    }
    if (isRegress) {
      regressions.push({
        metric: key,
        base,
        now,
        delta: +delta.toFixed(4),
        tolerance: tol[key],
      });
    }
  }
  return { regressions, hasRegression: regressions.length > 0 };
}
