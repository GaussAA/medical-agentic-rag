// content-need-alignment-test.mjs
// 第六维「内容-需求对齐度」单元测：纯函数全注入，零 LLM / 零 DB / CI 确定性。
import {
  normTitle,
  extractDemandGuides,
  extractRealCoveredTitles,
  realContentCoverage,
  versionStaleness,
  naiveNameMatchRate,
  matchedSourceNames,
  demandCoverageDepth,
  untestedBreadthRatio,
  indexCoverage,
  buildAlignmentReport,
} from "../../scripts/kb/content-need-alignment.mjs";

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

// ---- 合成数据（贴近真实结构）----
const GOLD = [
  { id: "q1", gtSources: ["原发性肝癌诊疗指南（2026版）"] },
  { id: "q2", gtSources: ["儿童肺炎支原体肺炎诊疗指南（2025年版）", "新型抗肿瘤药物临床应用指导原则（2025年版）"] },
  { id: "q3", gtSources: ["不存在的指南XXX"] },
];
const KB_SOURCES = {
  sources: [
    { name: "原发性肝癌诊疗指南（2026版）", localPath: "raw\\原发性肝癌诊疗指南（2026版）.pdf" },
    { name: "儿童肺炎支原体肺炎诊疗指南（2025年版）", localPath: "raw\\儿童肺炎支原体肺炎诊疗指南（2025年版）.pdf" },
    { name: "新型抗肿瘤药物临床应用指导原则（2025年版）", localPath: "raw\\新型抗肿瘤药物临床应用指导原则（2025年版）.pdf" },
    { name: "儿童肺炎支原体肺炎诊疗指南（2023年版）", localPath: "raw\\儿童肺炎支原体肺炎诊疗指南（2023年版）.txt" },
    { name: "新型抗肿瘤药物临床应用指导原则(2022年版)", localPath: "raw\\新型抗肿瘤药物临床应用指导原则(2022年版).docx" },
  ],
};
const GUIDE_MAP = {
  "原发性肝癌诊疗指南（2026版）": { deprecated: false, supersededBy: null },
  "儿童肺炎支原体肺炎诊疗指南（2025年版）": { deprecated: false, supersededBy: null },
  "新型抗肿瘤药物临床应用指导原则（2025年版）": { deprecated: false, supersededBy: null },
  "儿童肺炎支原体肺炎诊疗指南（2023年版）": { deprecated: true, supersededBy: "儿童肺炎支原体肺炎诊疗指南（2025年版）" },
  "新型抗肿瘤药物临床应用指导原则(2022年版)": { deprecated: true, supersededBy: "新型抗肿瘤药物临床应用指导原则（2025年版）" },
};
const CHUNK_PATHS = [
  "原发性肝癌诊疗指南（2026版）.pdf",
  "_oversized_split/肝癌2026/part_001.pdf", // 同指南，oversized 短 key → 应映射回标题
  "儿童肺炎支原体肺炎诊疗指南（2025年版）.pdf",
  "新型抗肿瘤药物临床应用指导原则（2025年版）.pdf",
];

async function run() {
  // 1) normTitle：去扩展名/括号/空白
  ok(normTitle("原发性肝癌诊疗指南（2026版）.pdf") === "原发性肝癌诊疗指南2026版", "normTitle 去扩展名+括号+空白");
  ok(normTitle("新型抗肿瘤药物临床应用指导原则(2022年版).docx") === "新型抗肿瘤药物临床应用指导原则2022年版", "normTitle 半角括号归一");

  // 2) extractDemandGuides：扁平去重
  {
    const d = extractDemandGuides(GOLD);
    ok(d.length === 4, "extractDemandGuides 去重得 4 项");
    ok(d.includes("不存在的指南XXX"), "extractDemandGuides 含唯一项");
  }

  // 3) extractRealCoveredTitles：普通 + oversized 映射
  {
    const t = extractRealCoveredTitles(CHUNK_PATHS);
    ok(t.includes("原发性肝癌诊疗指南（2026版）"), "oversized 短 key 肝癌2026 映射回标题");
    ok(t.filter((x) => x.includes("肝癌")).length === 1, "同指南多形态去重为 1");
  }

  // 4) realContentCoverage：3 命中 + 1 缺失
  {
    const cov = realContentCoverage(extractDemandGuides(GOLD), extractRealCoveredTitles(CHUNK_PATHS));
    ok(cov.total === 4, "覆盖率分母 = 需求指南数 4");
    ok(cov.covered === 3, "覆盖率分子 = 3（真实落地）");
    ok(cov.missing.length === 1 && cov.missing[0] === "不存在的指南XXX", "缺失项正确识别");
    ok(Math.abs(cov.rate - 0.75) < 1e-9, "覆盖率 = 0.75");
  }
  {
    // 100% 情形
    const cov = realContentCoverage(["A指南（2025版）"], ["A指南（2025版）.pdf"]);
    ok(cov.rate === 1 && cov.missing.length === 0, "100% 覆盖无缺失");
  }

  // 5) versionStaleness：计数 deprecated/superseded
  {
    const s = versionStaleness(GUIDE_MAP);
    ok(s.count === 2, "版本陈旧计数 = 2");
    ok(s.items.every((i) => i.deprecated), "陈旧项均 deprecated");
  }

  // 6) naiveNameMatchRate：名匹配 + 未匹配
  {
    const nm = naiveNameMatchRate(extractDemandGuides(GOLD), KB_SOURCES.sources.map((s) => s.name));
    ok(nm.total === 4, "名匹配分母 4");
    ok(nm.matched === 3, "名匹配分子 3（假名无对应源）");
    ok(nm.unmatched.length === 1 && nm.unmatched[0] === "不存在的指南XXX", "未匹配项正确");
  }

  // 7) matchedSourceNames：去重计源
  {
    const ms = matchedSourceNames(extractDemandGuides(GOLD), KB_SOURCES.sources.map((s) => s.name));
    ok(ms.length === 3, "被 gold 覆盖的源 = 3（去重）");
  }

  // 8) demandCoverageDepth / untestedBreadthRatio
  {
    const d = demandCoverageDepth(4, 5);
    ok(Math.abs(d - 0.8) < 1e-9, "需求覆盖深度 = 0.8");
    const u = untestedBreadthRatio(3, 5);
    ok(Math.abs(u - 0.4) < 1e-9, "未测广度 = 0.4");
  }

  // 9) indexCoverage
  {
    const ic = indexCoverage(GUIDE_MAP, KB_SOURCES);
    ok(ic.indexed === 5 && ic.total === 5 && ic.rate === 1, "索引覆盖率 = 1");
  }

  // 10) buildAlignmentReport：端到端装配 + 总判定（覆盖率 0.75 → FAIL）
  {
    const rep = buildAlignmentReport({ goldItems: GOLD, kbSources: KB_SOURCES, guideMap: GUIDE_MAP, chunkFilePaths: CHUNK_PATHS });
    ok(rep.metrics.realContentCoverage.rate === 0.75, "报告含覆盖率 0.75");
    ok(rep.metrics.versionStaleness.count === 2, "报告含版本陈旧 2");
    ok(rep.metrics.naiveNameMatchRate.rate === 0.75, "报告含名匹配 0.75");
    ok(rep.overall === "FAIL", "总判定 FAIL（覆盖率 0.75 低于阈值）");
    ok(Array.isArray(rep.notes) && rep.notes.length > 0, "报告含 notes");
  }
  {
    // WARN 主导场景：覆盖率 0.9（19/20）→ WARN，其余全 PASS
    const demands = Array.from({ length: 20 }, (_, i) => `指南${i}（2025版）`);
    const rep = buildAlignmentReport({
      goldItems: demands.map((d) => ({ gtSources: [d] })),
      kbSources: { sources: demands.map((d) => ({ name: d })) },
      guideMap: Object.fromEntries(demands.map((d) => [d, { deprecated: false }])),
      chunkFilePaths: demands.slice(0, 19).map((d) => `${d}.pdf`),
    });
    ok(rep.metrics.realContentCoverage.rate === 0.95, "WARN 场景覆盖率 0.95");
    ok(rep.overall === "WARN", "总判定 WARN（覆盖率介于阈值间）");
  }
  {
    // 全绿场景：无陈旧 + 全覆盖 + 全名匹配 + 全索引
    const rep = buildAlignmentReport({
      goldItems: [{ gtSources: ["原发性肝癌诊疗指南（2026版）"] }],
      kbSources: { sources: [{ name: "原发性肝癌诊疗指南（2026版）" }] },
      guideMap: { "原发性肝癌诊疗指南（2026版）": { deprecated: false } },
      chunkFilePaths: ["原发性肝癌诊疗指南（2026版）.pdf"],
    });
    ok(rep.overall === "PASS", "全绿场景总判定 PASS");
  }

  // 11) 空输入不崩
  {
    const rep = buildAlignmentReport({ goldItems: [], kbSources: { sources: [] }, guideMap: {}, chunkFilePaths: [] });
    ok(rep.overall === "PASS" || rep.overall === "SKIP", "空输入不崩且 PASS/SKIP");
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log("失败项:");
    for (const f of fails) console.log("  -", f);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(1);
});
