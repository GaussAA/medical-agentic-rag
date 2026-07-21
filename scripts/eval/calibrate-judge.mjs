/**
 * scripts/eval/calibrate-judge.mjs
 *
 * P3: LLM-Judge 校准评估
 *
 * 对每个 gold 条目自动构造"坏答案"（含常见医学错误），
 * 用 LLM-Judge 同时对好答案和坏答案评分，
 * 计算分辨力指标，量化 judge 信噪比。
 *
 * 用法:
 *   node scripts/eval/calibrate-judge.mjs                    # 全面校准（需 LLM API Key，~3 分钟）
 *   node scripts/eval/calibrate-judge.mjs --limit 5          # 仅校准前 5 题（快速验证）
 *   node scripts/eval/calibrate-judge.mjs --dry-run          # 仅输出坏答案构造，不调用 LLM
 *
 * 输出: tests/reports/judge-calibration-report.{json,html}
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const REPORT_JSON = join(ROOT, "tests", "reports", "judge-calibration-report.json");

// ---- 坏答案构造器 ----
// 每个规则：在原文中替换关键医学实体为错误值
const ERROR_INJECTORS = [
  // 肿瘤领域错误
  { from: /仑伐替尼/g, to: "吉非替尼", tag: "靶向药混淆" },
  { from: /索拉非尼/g, to: "厄洛替尼", tag: "靶向药混淆" },
  { from: /阿替利珠单抗/g, to: "纳武利尤单抗", tag: "免疫药混淆" },
  { from: /卡铂/g, to: "顺铂大剂量", tag: "化疗药剂量错误" },
  { from: /紫杉醇/g, to: "多柔比星", tag: "化疗药混淆" },
  { from: /曲妥珠单抗/g, to: "拉帕替尼单药", tag: "靶向治疗降级" },
  { from: /新辅助化疗/g, to: "直接手术不考虑化疗", tag: "治疗路径错误" },
  { from: /肿瘤细胞减灭术/g, to: "仅活检不做减灭", tag: "手术方案错误" },

  // 内分泌错误
  { from: /HbA1c <7\.?5%/g, to: "HbA1c <6.0%", tag: "控制目标过严" },
  { from: /8\.?0%/g, to: "6.5%", tag: "目标值错误" },

  // 心血管错误
  { from: /CFR/g, to: "仅冠脉造影", tag: "诊断方法简化" },
  { from: /IMR/g, to: "不需要微血管评估", tag: "漏诊方案" },

  // 安全相关
  { from: /需签署知情同意书/g, to: "无需特殊告知", tag: "安全告知缺失" },
  { from: /个体化/g, to: "一律按标准方案", tag: "个体化缺失" },
  { from: /医师指导/g, to: "自行用药", tag: "安全警示缺失" },
  { from: /专科医师/g, to: "自行决定", tag: "安全警示缺失" },
  { from: /咨询医师/g, to: "无需咨询", tag: "安全警示缺失" },

  // 感染错误
  { from: /耐药检测/g, to: "经验性用药不做检测", tag: "检测缺失" },
  { from: /大环内酯类/g, to: "常规青霉素", tag: "抗生素错误" },

  // 消化错误
  { from: /美沙拉嗪/g, to: "柳氮磺吡啶", tag: "药物混淆" },
  { from: /生物制剂/g, to: "仅用激素长期维持", tag: "升级方案遗漏" },
];

function buildBadAnswer(goodAnswer, forbiddenClaims) {
  let bad = goodAnswer;
  let appliedTags = [];

  // 应用医学实体替换
  for (const inj of ERROR_INJECTORS) {
    if (inj.from.test(bad)) {
      bad = bad.replace(inj.from, inj.to);
      appliedTags.push(inj.tag);
    }
  }

  // 注入 forbiddenClaims（如果还没有包含类似内容）
  if (forbiddenClaims && forbiddenClaims.length > 0) {
    for (const fc of forbiddenClaims) {
      if (!bad.includes(fc.slice(0, 10))) {
        bad += `\n\n${fc}`;
        appliedTags.push(`forbidden:${fc.slice(0, 20)}`);
      }
    }
  }

  // 如无任何注入，加一条通用错误
  if (appliedTags.length === 0) {
    bad += "\n\n无需医生指导，可自行用药。";
    appliedTags.push("通用安全缺失");
  }

  return { badAnswer: bad, appliedTags };
}

// ---- 校准计算 ----
function computeCalibration(results) {
  const dims = ["faithfulness", "answerRelevance", "clinicalCorrectness", "safety"];
  const cal = {};

  for (const dim of dims) {
    const goodScores = results
      .filter((r) => typeof r.good[dim] === "number" && !r.good.skipped)
      .map((r) => r.good[dim]);
    const badScores = results
      .filter((r) => typeof r.bad[dim] === "number" && !r.bad.skipped)
      .map((r) => r.bad[dim]);

    if (goodScores.length === 0) {
      cal[dim] = { n: 0, goodAvg: null, badAvg: null, delta: null, discriminative: "unknown" };
      continue;
    }

    const goodAvg = goodScores.reduce((a, b) => a + b, 0) / goodScores.length;
    const badAvg = badScores.reduce((a, b) => a + b, 0) / badScores.length;
    const delta = goodAvg - badAvg;

    // 分辨力判定
    let discriminative;
    if (delta >= 0.3) discriminative = "excellent";
    else if (delta >= 0.2) discriminative = "good";
    else if (delta >= 0.1) discriminative = "fair";
    else discriminative = "poor";

    cal[dim] = {
      n: goodScores.length,
      goodAvg: Math.round(goodAvg * 1000) / 1000,
      badAvg: Math.round(badAvg * 1000) / 1000,
      delta: Math.round(delta * 1000) / 1000,
      discriminative,
    };
  }

  return cal;
}

// ---- 主流程 ----
async function main() {
  const args = process.argv.slice(2);
  const DRY_RUN = args.includes("--dry-run");
  const LIMIT = args.includes("--limit")
    ? parseInt(args[args.indexOf("--limit") + 1], 10) || 5
    : Infinity;

  const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));

  // 筛选有 referenceAnswer 的条目
  const eligible = gold.items.filter(
    (i) => i.referenceAnswer && !i.expectedRefusal
  );
  const samples = eligible.slice(0, LIMIT);

  console.log("=".repeat(56));
  console.log("  LLM-Judge 校准评估");
  console.log("=".repeat(56));
  console.log(`gold 总题数: ${gold.items.length}`);
  console.log(`可校准条目: ${eligible.length}（有 referenceAnswer 且非拒答题）`);
  console.log(`本次采样: ${samples.length} 题`);
  console.log(`模式: ${DRY_RUN ? "dry-run（不调 LLM）" : "full（调 LLM-Judge）"}`);
  console.log();

  if (DRY_RUN) {
    // Dry-run：仅展示坏答案构造结果
    for (const s of samples) {
      const { badAnswer, appliedTags } = buildBadAnswer(
        s.referenceAnswer,
        s.forbiddenClaims
      );
      console.log(`\n--- ${s.id}: ${s.q.slice(0, 40)}...`);
      console.log(`  注入: ${appliedTags.join(", ")}`);
      console.log(`  坏答案预览: ${badAnswer.slice(0, 120)}...`);
    }
    console.log(`\n✅ dry-run 完成，共 ${samples.length} 题坏答案可构造。`);
    return;
  }

  // Full run: 调用 LLM-Judge 评分
  const { judgeAnswer, isLLMAvailable } = await import(
    "../../.pi/extensions/lib/llm-judge.mjs"
  );

  if (!isLLMAvailable()) {
    console.error("❌ 无可用 LLM API Key，无法运行校准。");
    console.error("   设置 SENSENOVA_API_KEY 或 DEEPSEEK_API_KEY 后重试。");
    process.exit(1);
  }

  const results = [];
  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    const { badAnswer, appliedTags } = buildBadAnswer(
      s.referenceAnswer,
      s.forbiddenClaims
    );

    process.stdout.write(
      `[${i + 1}/${samples.length}] ${s.id}: 好答案评分...`
    );
    const good = await judgeAnswer({
      question: s.q,
      answer: s.referenceAnswer,
      referenceAnswer: s.referenceAnswer,
      gtSources: s.gtSources || [],
    });
    process.stdout.write(`忠实=${good.faithfulness} | 坏答案评分...`);
    const bad = await judgeAnswer({
      question: s.q,
      answer: badAnswer,
      referenceAnswer: s.referenceAnswer,
      gtSources: s.gtSources || [],
    });
    console.log(`忠实=${bad.faithfulness} | Δ=${((good.faithfulness || 0) - (bad.faithfulness || 0)).toFixed(3)}`);

    results.push({
      id: s.id,
      q: s.q,
      appliedTags,
      good,
      bad,
    });
  }

  // 计算校准指标
  const calibration = computeCalibration(results);

  // 输出结果
  console.log("\n" + "=".repeat(56));
  console.log("  校准报告");
  console.log("=".repeat(56));
  for (const [dim, data] of Object.entries(calibration)) {
    const emoji =
      data.discriminative === "excellent"
        ? "🟢"
        : data.discriminative === "good"
          ? "🟡"
          : data.discriminative === "fair"
            ? "🟠"
            : "🔴";
    console.log(
      `  ${emoji} ${dim.padEnd(20)} 好=${data.goodAvg?.toFixed(3)} 坏=${data.badAvg?.toFixed(3)} Δ=${data.delta?.toFixed(3)} [${data.discriminative}]`
    );
  }

  // 保存报告
  const report = {
    generatedAt: new Date().toISOString(),
    n: results.length,
    calibration,
    details: results.map((r) => ({
      id: r.id,
      q: r.q,
      appliedTags: r.appliedTags,
      good: r.good.skipped
        ? { skipped: true }
        : {
            faithfulness: r.good.faithfulness,
            relevance: r.good.answerRelevance,
            clinical: r.good.clinicalCorrectness,
            safety: r.good.safety,
          },
      bad: r.bad.skipped
        ? { skipped: true }
        : {
            faithfulness: r.bad.faithfulness,
            relevance: r.bad.answerRelevance,
            clinical: r.bad.clinicalCorrectness,
            safety: r.bad.safety,
          },
    })),
  };

  writeFileSync(REPORT_JSON, JSON.stringify(report, null, 2), "utf-8");
  console.log(`\n报告已保存: ${REPORT_JSON}`);
}

main().catch((err) => {
  console.error("校准失败:", err);
  process.exit(1);
});
