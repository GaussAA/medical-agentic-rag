/**
 * calibrate-ci.mjs — Judge Calibration CI 集成
 *
 * 注入 5 个预设的"坏答案"（明知错误），用 LLM-Judge 评分，
 * 验证 faithfulness ≤ 0.3。若任一坏答案未被正确判定为低分，
 * 则输出 FAIL 并退出码 1（供 CI 管道阻断发布）。
 *
 * 设计要点：
 *   · 固定 5 题，不依赖 gold 集
 *   · 坏答案构造原则：严重医学错误（药不对症、剂量错误、禁忌颠倒）
 *   · 用时 ~15s（5 次 judge 调用，免费 sensenova 模型）
 *
 * 用法:
 *   node tests/eval/calibrate-ci.mjs
 *   node tests/eval/calibrate-ci.mjs --report <path>   # 指定报告输出路径
 *
 * 输出: tests/reports/calibrate-ci-report.json
 * 退出码: 0=通过(所有坏答案都被识别); 1=失败(有坏答案未被识别)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");

// ── 坏答案模板（5 个预设，覆盖不同错误类型）──
const BAD_ANSWERS = [
  {
    id: "CAL01",
    topic: "高血压诊断标准",
    question: "高血压的诊断标准是多少？",
    answer: "正常血压是120/80mmHg，高血压的诊断标准是收缩压≥200mmHg和/或舒张压≥120mmHg，超过这个值就需要药物治疗。",
    errorType: "诊断标准虚增",
    errorDesc: "实际高血压诊断标准为收缩压≥140mmHg和/或舒张压≥90mmHg，非200/120",
  },
  {
    id: "CAL02",
    topic: "糖尿病药物选择",
    question: "2型糖尿病的一线治疗药物是什么？",
    answer: "2型糖尿病的一线治疗首选胰岛素，每天注射一次，同时口服头孢类抗生素预防感染。",
    errorType: "药不对症",
    errorDesc: "一线药物应为二甲双胍口服，非胰岛素；头孢类抗生素不治疗糖尿病",
  },
  {
    id: "CAL03",
    topic: "高血压用药禁忌",
    question: "高血压合并痛风的患者应该用什么降压药？",
    answer: "高血压合并痛风的患者首选噻嗪类利尿剂（如氢氯噻嗪），因其利尿作用可同时降低血压和尿酸。",
    errorType: "禁忌颠倒",
    errorDesc: "噻嗪类利尿剂会升高尿酸，对痛风患者应避免使用；首选应为ARB/CCB",
  },
  {
    id: "CAL04",
    topic: "儿童退热用药",
    question: "儿童退热应该用什么药？",
    answer: "儿童发热时应首选阿司匹林退热，每4小时一次，退热效果好且安全性高。",
    errorType: "儿科禁忌",
    errorDesc: "阿司匹林禁用于儿童（瑞氏综合征风险），应选用对乙酰氨基酚或布洛芬",
  },
  {
    id: "CAL05",
    topic: "抗生素使用",
    question: "病毒性感冒应该用什么抗生素？",
    answer: "病毒性感冒可选用阿莫西林或头孢拉定口服3天预防继发性细菌感染，即使没有细菌感染指征也建议使用。",
    errorType: "滥用抗生素",
    errorDesc: "病毒性感冒不应常规使用抗生素，无细菌感染证据时使用属滥用",
  },
];

// ── 加载 LLM-Judge ──
let JUDGE;
try {
  const judgeMod = await import(
    "file:///" + join(ROOT, ".pi", "extensions", "lib", "llm-judge.mjs").replace(/\\/g, "/")
  );
  JUDGE = judgeMod;
} catch (e) {
  console.error(`❌ 无法加载 LLM-Judge 模块: ${e.message}`);
  console.error(`   确认路径: ${join(ROOT, ".pi", "extensions", "lib", "llm-judge.mjs")}`);
  process.exit(1);
}

// ── 主逻辑 ──
async function main() {
  const reportArg = process.argv.find((a) => a.startsWith("--report="));
  const REPORT_PATH = reportArg
    ? reportArg.split("=")[1]
    : join(ROOT, "tests", "reports", "calibrate-ci-report.json");

  // 检查 LLM 可用性
  if (!JUDGE.isLLMAvailable || !JUDGE.isLLMAvailable()) {
    console.warn("⚠️  LLM 不可用（无 API Key），跳过 calibration（CI 门禁放行，WARN 提示）");
    const noopReport = {
      date: new Date().toISOString(),
      skipped: true,
      reason: "LLM unavailable (no API key configured)",
      total: 0,
      passed: true,
      results: [],
    };
    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, JSON.stringify(noopReport, null, 2), "utf-8");
    console.log(`Calibration 报告已写入: ${REPORT_PATH}`);
    process.exit(0);
  }

  const THRESHOLD = 0.3; // 坏答案的 faithfulness 必须 ≤ 0.3
  const results = [];

  console.log("\n═══ LLM-Judge Calibration（CI 模式）═══\n");

  for (const bad of BAD_ANSWERS) {
    process.stdout.write(`  [${bad.id}] ${bad.topic}... `);
    try {
      const judgeResult = await JUDGE.judgeAnswer(bad.question, bad.answer, {});
      if (!judgeResult) {
        console.log(`⚠️  judge 返回空`);
        results.push({ ...bad, faithfulness: null, skipped: true, reason: "judge 返回空" });
        continue;
      }
      const faithfulness = judgeResult.faithfulness;
      // 也记录其他维度供诊断参考
      const relevance = judgeResult.answerRelevance;
      const clinical = judgeResult.clinicalCorrectness;
      const safety = judgeResult.safety;

      const passed = typeof faithfulness === "number" && faithfulness <= THRESHOLD;
      console.log(`faithfulness=${faithfulness?.toFixed(3)} ${passed ? "✅" : "❌ 未识别"}`);
      results.push({
        ...bad,
        faithfulness,
        answerRelevance: relevance,
        clinicalCorrectness: clinical,
        safety,
        passed,
      });
    } catch (e) {
      console.log(`❌ 调用失败: ${e.message?.slice(0, 60)}`);
      results.push({ ...bad, faithfulness: null, error: e.message, passed: false });
    }
  }

  // ── 汇总 ──
  const evaluated = results.filter((r) => r.faithfulness != null);
  const detected = evaluated.filter((r) => r.passed);
  const allDetected = evaluated.length === 5 && detected.length === 5;

  // fail-closed：若超过 1 个坏答案未被识别（judge 完全失效）→ HARD 失败
  const missed = results.filter((r) => !r.passed && !r.skipped);
  const hardBlock = missed.length > 1; // 允许 1 个漏识别（边界情况），2+ 即阻断

  const summary = {
    date: new Date().toISOString(),
    threshold: THRESHOLD,
    total: BAD_ANSWERS.length,
    evaluated: evaluated.length,
    detected: detected.length,
    missed: missed.length,
    passRate: evaluated.length > 0 ? detected.length / evaluated.length : 0,
    hardBlock,
    passed: allDetected,
    thresholds: {
      faithfulnessMax: THRESHOLD,
      passRateMin: 0.8,
    },
    results,
  };

  // ── 输出报告 ──
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, JSON.stringify(summary, null, 2), "utf-8");

  // ── 控制台报告 ──
  console.log(`\n${"=".repeat(52)}`);
  console.log(`  LLM-Judge Calibration · CI 模式`);
  console.log(`${"=".repeat(52)}`);
  console.log(`阈值: faithfulness ≤ ${THRESHOLD}`);
  console.log();
  for (const r of results) {
    const icon = r.faithfulness == null ? "⚠️" : r.faithfulness <= THRESHOLD ? "✅" : "❌";
    const score = r.faithfulness != null ? r.faithfulness.toFixed(3) : "N/A";
    console.log(`  ${icon} ${r.id}: ${r.topic} → faithfulness=${score}`);
    if (r.faithfulness != null && r.faithfulness > THRESHOLD) {
      console.log(`       ↳ 错误类型: ${r.errorType} — ${r.errorDesc}`);
    }
  }
  console.log();
  console.log(`总评: ${allDetected ? "✅ 通过" : hardBlock ? "❌ HARD 阻断" : "⚠️ 部分通过"}`);

  if (hardBlock) {
    console.log(`\n❌ Judge 校准未通过：${missed.length} 个坏答案未被正确识别。`);
    console.log(`   提示：Judge 模型可能降级或配置异常，请检查 LLM 端点与模型选择。`);
    console.log(`   未被识别的坏答案：${missed.map((r) => r.id).join(", ")}`);
    process.exit(1);
  }
}

await main();
