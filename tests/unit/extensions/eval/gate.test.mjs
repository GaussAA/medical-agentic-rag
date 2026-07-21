// eval-gate-test.mjs
// eval-ci-gate 回归对比纯逻辑单测：零文件 IO（传入对象），进 CI。
// 运行: node tests/unit/eval-gate-test.mjs

import { compareRegression, REGRESS_TOLERANCES } from "../../../../.pi/extensions/lib/eval-compare.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
    console.error("  ✗ " + name);
  }
}

// 构造报告：默认全部健康
const mk = (over) => ({
  metrics: {
    kpi: {
      citationRecall: 92,
      forbiddenViolationRate: 0,
      llmJudge: {
        faithfulness: 0.98,
        safety: 1.0,
        clinicalCorrectness: 0.95,
        answerRelevance: 1.0,
      },
      ...over,
    },
  },
});

// 1. 持平 → 无退步
{
  const base = mk({});
  const now = mk({});
  const r = compareRegression(now, base);
  ok(r.hasRegression === false && r.regressions.length === 0, "持平 → 无退步");
}

// 2. citationRecall 大幅下降 → 退步
{
  const base = mk({ citationRecall: 92 });
  const now = mk({ citationRecall: 80 }); // 降 12 > 5
  const r = compareRegression(now, base);
  ok(
    r.hasRegression === true &&
      r.regressions.some((x) => x.metric === "citationRecall"),
    "citationRecall 降12 → 退步",
  );
}

// 3. safety 小幅下降在容差内 → 不退步
{
  const base = mk({
    llmJudge: { faithfulness: 0.98, safety: 1.0, clinicalCorrectness: 0.95, answerRelevance: 1.0 },
  });
  const now = mk({
    llmJudge: { faithfulness: 0.98, safety: 0.99, clinicalCorrectness: 0.95, answerRelevance: 1.0 },
  });
  const r = compareRegression(now, base);
  ok(r.hasRegression === false, "safety 降0.01 在容差内 → 不退步");
}

// 4. safety 大幅下降 → 退步
{
  const base = mk({
    llmJudge: { faithfulness: 0.98, safety: 1.0, clinicalCorrectness: 0.95, answerRelevance: 1.0 },
  });
  const now = mk({
    llmJudge: { faithfulness: 0.98, safety: 0.9, clinicalCorrectness: 0.95, answerRelevance: 1.0 },
  });
  const r = compareRegression(now, base);
  ok(r.hasRegression === true, "safety 降0.1 → 退步");
}

// 5. forbiddenViolationRate 上升 → 退步（越小越好）
{
  const base = mk({ forbiddenViolationRate: 0 });
  const now = mk({ forbiddenViolationRate: 5 }); // 升 5 > 2
  const r = compareRegression(now, base);
  ok(
    r.hasRegression === true &&
      r.regressions.some((x) => x.metric === "forbiddenViolationRate"),
    "禁戒违例升5 → 退步",
  );
}

// 6. 缺少字段跳过（不误报）
{
  const base = {}; // 无 metrics
  const now = mk({});
  const r = compareRegression(now, base);
  ok(r.hasRegression === false, "基线缺字段 → 跳过不误报");
}

// 7. 自定义容差
{
  const base = mk({ citationRecall: 92 });
  const now = mk({ citationRecall: 88 }); // 降 4
  const r = compareRegression(now, base, { tolerances: { citationRecall: 2 } });
  ok(r.hasRegression === true, "自定义容差2 → 降4 退步");
  const r2 = compareRegression(now, base, { tolerances: { citationRecall: 10 } });
  ok(r2.hasRegression === false, "自定义容差10 → 降4 不退步");
}

console.log(`\n回归对比单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
