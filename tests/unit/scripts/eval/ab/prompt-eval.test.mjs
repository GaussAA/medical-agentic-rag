// ab-prompt-eval-test.mjs
// 提示词 A/B 自调优评测引擎 —— 纯函数单元测试（零 Key、原生 node 可跑）。
// 覆盖：aggregate 均值聚合 / compareDimensions 方向判定 / decideVerdict 三态 /
//       buildReport 结构 / skipped 排除 / 绝不触碰 gold。

import {
  aggregate,
  compareDimensions,
  decideVerdict,
  buildReport,
} from "../../../../../scripts/eval/ab/ab-prompt-eval.mjs";

// 构造一对 A/B 评分（四维）
function pair(a, b) {
  return { scoresA: { ...a }, scoresB: { ...b } };
}
const GOOD = { faithfulness: 0.9, answerRelevance: 0.9, clinicalCorrectness: 0.9, safety: 1.0 };
const BETTER = { faithfulness: 0.95, answerRelevance: 0.95, clinicalCorrectness: 0.95, safety: 1.0 };
const WORSE_SAFE = { faithfulness: 0.95, answerRelevance: 0.95, clinicalCorrectness: 0.95, safety: 0.9 };
const WORSE_RELEVANCE = { faithfulness: 0.9, answerRelevance: 0.8, clinicalCorrectness: 0.9, safety: 1.0 };
const FLAT = { ...GOOD };

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    fail++;
    console.log(`  ✗ ${name}`);
  }
}

console.log("[1] aggregate — 四维均值聚合");
{
  const agg = aggregate([
    pair(GOOD, BETTER),
    pair(GOOD, BETTER),
  ]);
  ok("meansA.faithfulness=0.9", agg.meansA.faithfulness === 0.9);
  ok("meansB.faithfulness=0.95", agg.meansB.faithfulness === 0.95);
  ok("deltas.faithfulness=+0.05", agg.deltas.faithfulness === 0.05);
  ok("deltas.safety=0", agg.deltas.safety === 0);
  ok("validCount=2", agg.validCount === 2);
  ok("total=2", agg.total === 2);
}

console.log("[2] aggregate — skipped 排除");
{
  const agg = aggregate([
    pair(GOOD, BETTER),
    pair({ skipped: true, reason: "x" }, BETTER),
    pair(GOOD, { skipped: true, reason: "y" }),
  ]);
  // 仅第1对 A/B 均有效参与均值
  ok("meansA.faithfulness=0.9（仅有效项）", agg.meansA.faithfulness === 0.9);
  ok("meansB.faithfulness=0.95（仅有效项）", agg.meansB.faithfulness === 0.95);
  ok("validCount=1（跳过含 skipped 对）", agg.validCount === 1);
  ok("total=3", agg.total === 3);
}

console.log("[3] compareDimensions — 方向判定");
{
  const agg = aggregate([pair(GOOD, BETTER)]);
  const cmp = compareDimensions(agg);
  ok("lifts=3（忠实/相关/临床提升）", cmp.lifts === 3);
  ok("drops=0", cmp.drops === 0);
  ok("net=3", cmp.net === 3);
  const fd = cmp.perDim.find((d) => d.dim === "faithfulness");
  ok("faithfulness 方向 up", fd.direction === "up");
  const sd = cmp.perDim.find((d) => d.dim === "safety");
  ok("safety 方向 flat", sd.direction === "flat");
}

console.log("[4] decideVerdict — REJECT（安全硬回退）");
{
  const agg = aggregate([pair(GOOD, WORSE_SAFE)]);
  const v = decideVerdict(agg);
  ok("verdict=REJECT", v.verdict === "REJECT");
  ok("理由含安全否决", v.reasons.some((r) => r.includes("安全")));
  // 即便其他维度提升，安全回退仍否决
  const agg2 = aggregate([
    pair({ faithfulness: 0.5, answerRelevance: 0.5, clinicalCorrectness: 0.5, safety: 1.0 },
         { faithfulness: 1.0, answerRelevance: 1.0, clinicalCorrectness: 1.0, safety: 0.9 }),
  ]);
  ok("安全回退即便其余大涨仍 REJECT", decideVerdict(agg2).verdict === "REJECT");
}

console.log("[5] decideVerdict — ADOPT_WITH_CAUTION（非安全维度回退）");
{
  const agg = aggregate([pair(GOOD, WORSE_RELEVANCE)]);
  const v = decideVerdict(agg);
  ok("verdict=ADOPT_WITH_CAUTION", v.verdict === "ADOPT_WITH_CAUTION");
  ok("理由含维度回退", v.reasons.some((r) => r.includes("回退")));
}

console.log("[6] decideVerdict — ADOPT（有提升）");
{
  const agg = aggregate([pair(GOOD, BETTER)]);
  const v = decideVerdict(agg);
  ok("verdict=ADOPT", v.verdict === "ADOPT");
  ok("理由含建议采纳", v.reasons.some((r) => r.includes("采纳")));
}

console.log("[7] decideVerdict — ADOPT_WITH_CAUTION（持平无提升）");
{
  const agg = aggregate([pair(GOOD, FLAT)]);
  const v = decideVerdict(agg);
  ok("verdict=ADOPT_WITH_CAUTION（持平）", v.verdict === "ADOPT_WITH_CAUTION");
}

console.log("[8] decideVerdict — 阈值敏感性");
{
  // safety 仅回退 0.01（< 硬阈值 0.02）→ 不否决
  const agg = aggregate([
    pair({ faithfulness: 0.9, answerRelevance: 0.9, clinicalCorrectness: 0.9, safety: 1.0 },
         { faithfulness: 0.9, answerRelevance: 0.9, clinicalCorrectness: 0.9, safety: 0.99 }),
  ]);
  ok("safety 微退 0.01 不触发 REJECT", decideVerdict(agg).verdict !== "REJECT");
  // 自定义硬阈值收窄到 0.005 → 触发
  ok("safetyHardDrop=0.005 时 0.01 回退触发 REJECT",
    decideVerdict(agg, { safetyHardDrop: 0.005 }).verdict === "REJECT");
}

console.log("[9] buildReport — 结构完整");
{
  const input = {
    meta: { promptA: "A", promptB: "B", note: "测试" },
    items: [{ id: "Q1", q: "问题1", answerA: "a", answerB: "b" }],
  };
  const judged = [{ id: "Q1", q: "问题1", scoresA: GOOD, scoresB: BETTER }];
  const agg = aggregate(judged);
  const v = decideVerdict(agg);
  const report = buildReport(input, judged, agg, v, { limit: null, input: "x.json" });
  ok("含 generatedAt", !!report.generatedAt);
  ok("含 meta", report.meta.note === "测试");
  ok("含 summary.verdict", report.summary.verdict === "ADOPT");
  ok("含 summary.deltas", typeof report.summary.deltas.faithfulness === "number");
  ok("含 comparison.perDim(4维)", report.summary.comparison.perDim.length === 4);
  ok("items 明细含 id/q", report.items[0].id === "Q1" && report.items[0].q === "问题1");
  ok("items 明细含 scoresA/B", report.items[0].scoresA && report.items[0].scoresB);
  ok("skippedA/B 标记存在", "skippedA" in report.items[0] && "skippedB" in report.items[0]);
}

console.log("[10] 绝不触碰 gold（纯函数无文件副作用）");
{
  // 纯函数不接收/不返回任何文件路径；本测试仅断言函数不抛、不依赖外部文件读取。
  const agg = aggregate([pair(GOOD, BETTER)]);
  const v = decideVerdict(agg);
  ok("decideVerdict 不依赖 gold 文件即可执行", v && typeof v.verdict === "string");
  const report = buildReport({ meta: {}, items: [] }, [], agg, v, {});
  ok("buildReport 空 items 不抛", report.items.length === 0 && report.summary.total === 1);
}

console.log();
console.log(`=== 结果 ===`);
console.log(`通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.log(`失败 ${fail} 个`);
  process.exit(1);
}
