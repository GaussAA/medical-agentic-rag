// quality-gate-test.mjs
// scripts/kb/multisource/quality-gate.mjs 纯函数单测。
// 零网络、零 IO、零 mock，直接进 CI。
// 运行: node tests/unit/quality-gate-test.mjs

import {
  AUTHORITY, gateLicense, gateAuthority,
  gateRecency, gateRelevance, evaluateCandidate,
} from "../../../../../scripts/kb/multisource/quality-gate.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.error("  ✗", name, detail); }
}

console.log("\n=== quality-gate 纯函数单测 ===\n");

// ─────────────────────────────────────────────
console.log("[1] gateLicense — 许可闸门");
{
  // 开放许可 → 通过
  const cc = gateLicense({ license: "CC-BY-4.0" });
  ok(cc.pass === true, "CC-BY-4.0 → pass");
  ok(cc.reason.includes("开放许可"), "含适当原因");

  const oa = gateLicense({ openAccess: true });
  ok(oa.pass === true, "openAccess 标志 → pass");

  const pubMed = gateLicense({ licenseUrl: "https://www.ncbi.nlm.nih.gov/pmc/tools/openftlist/", openAccess: true });
  ok(pubMed.pass === true, "PMC OA URL + OA标志 → pass");

  // 付费墙 → 拒
  const pw = gateLicense({ license: "All Rights Reserved" });
  ok(pw.pass === false, "All Rights Reserved → 拒");
  ok(pw.reason.includes("付费墙"), "含付费墙原因");

  // 未知许可 → 保守拒
  const unk = gateLicense({ license: "Proprietary" });
  ok(unk.pass === false, "未知许可 → 保守拒");

  // 无许可且无 OA 标志 → 拒
  const noLic = gateLicense({});
  ok(noLic.pass === false, "无许可→拒");

  // 混合输入
  const mix = gateLicense({ license: "CC-BY-NC-SA 4.0", openAccess: true });
  ok(mix.pass === true, "CC-BY-NC-SA → pass");

  // null/undefined 安全
  ok(gateLicense({ license: null }).pass === false, "null license → 拒");
}

// ─────────────────────────────────────────────
console.log("\n[2] gateAuthority — 权威分级");
{
  const g = gateAuthority({ authority: "guideline" });
  ok(g.score === AUTHORITY.GUIDELINE, "guideline → 5");
  ok(g.label === "guideline", "label=guideline");

  const o = gateAuthority({ authority: "official" });
  ok(o.score === AUTHORITY.OFFICIAL, "official → 4");

  const s = gateAuthority({ authority: "society" });
  ok(s.score === AUTHORITY.SOCIETY, "society → 3");

  // 中文关键词
  const zh = gateAuthority({ authority: "中华医学会" });
  ok(zh.score === AUTHORITY.SOCIETY, "中华医学会 → society");

  const d = gateAuthority({ authority: "dataset" });
  ok(d.score === AUTHORITY.DATASET, "dataset → 2");

  const p = gateAuthority({ authority: "paper" });
  ok(p.score === AUTHORITY.PAPER, "paper → 1");

  const u = gateAuthority({ authority: "blog" });
  ok(u.score === AUTHORITY.UNKNOWN, "blog → 0");
  ok(u.label === "unknown", "label=unknown");

  const def = gateAuthority({});
  ok(def.score === 0, "无 authority → 0");
}

// ─────────────────────────────────────────────
console.log("\n[3] gateRecency — 时效闸门");
{
  const fresh = gateRecency({ year: 2024 }, { nowYear: 2026 });
  ok(fresh.pass === true && fresh.stale === false, "2024(近2年) → pass 非超龄");

  const old = gateRecency({ year: 2015 }, { nowYear: 2026 });
  ok(old.pass === true && old.stale === true, "2015(超10年) → pass 但标 stale");

  const noYear = gateRecency({}, { nowYear: 2026 });
  ok(noYear.pass === true && noYear.stale === false, "无年份 → pass 不拦截");

  // 自定义 maxAge
  const custom = gateRecency({ year: 2020 }, { nowYear: 2026, maxAge: 3 });
  ok(custom.stale === true, "2020 在 maxAge=3 窗口外 → stale");

  const customFresh = gateRecency({ year: 2024 }, { nowYear: 2026, maxAge: 3 });
  ok(customFresh.stale === false, "2024 在 maxAge=3 窗口内 → 非 stale");

  // 未来年份
  const future = gateRecency({ year: 2030 }, { nowYear: 2026 });
  ok(future.pass === true && future.stale === false, "未来年份 → 放行");

  // 字符串年份
  const strYear = gateRecency({ year: "2023" }, { nowYear: 2026 });
  ok(strYear.stale === false, "字符串年份 → 正常解析");
}

// ─────────────────────────────────────────────
console.log("\n[4] gateRelevance — 相关闸门");
{
  // 标题含疾病名 → pass
  const tPass = gateRelevance(
    { title: "中国糖尿病防治指南2024", disease: "糖尿病" },
    { keywords: ["糖尿病"] },
  );
  ok(tPass.pass === true, "标题含病名 → pass");
  ok(tPass.titleHasStrong === true, "titleHasStrong=true");
  ok(tPass.hits.length >= 1, "有命中关键词");

  // 完全无关 → 拒
  const fail = gateRelevance(
    { title: "植物学基础研究", text: "关于光合作用的实验数据" },
    { disease: "糖尿病", keywords: ["糖尿病"] },
  );
  ok(fail.pass === false, "完全无关 → 拒");

  // 高权威(GUIDELINE) + 正文含病名 → pass（指南常以「共识/治疗」冠标题）
  const guidelinePass = gateRelevance(
    { title: "专家共识：GLP-1 RA 的临床应用", text: "糖尿病患者的治疗方案", authority: "guideline" },
    { disease: "糖尿病", keywords: ["糖尿病"] },
  );
  ok(guidelinePass.pass === true, "高权威+正文病名 → pass");

  // 低权威 + 正文仅偶提 → 拒（防 COPD 论文蹭 asthma 词）
  const lowAuthFail = gateRelevance(
    { title: "肺功能检测新技术", text: "在哮喘患者中的应用及效果评估", authority: "paper" },
    { disease: "哮喘", keywords: ["哮喘"] },
  );
  ok(lowAuthFail.pass === false, "低权威+仅正文偶提 → 拒");

  // 排歧词：高血压排除 pulmonary
  const disambig = gateRelevance(
    { title: "Pulmonary Hypertension Diagnosis and Treatment", text: "Pulmonary hypertension management", disease: "高血压" },
    { disease: "高血压", keywords: ["高血压"], excludeTerms: ["pulmonary"] },
  );
  ok(disambig.pass === false, "排歧词: pulmonary hypertension 不命中高血压");

  // coreEn 英文核心词
  const coreEn = gateRelevance(
    { title: "Diabetes Care Standards 2024", text: "Diabetes management guidelines", disease: "糖尿病" },
    { disease: "糖尿病", keywords: ["糖尿病"], coreEn: "diabetes" },
  );
  ok(coreEn.pass === true, "coreEn(diabetes) → 标题含 diabetes → pass");

  // 空 disease → 不误杀
  const noDisease = gateRelevance(
    { title: "随便一篇文章", text: "" },
    {},
  );
  ok(noDisease.pass === false, "无 disease → 拒");
}

// ─────────────────────────────────────────────
console.log("\n[5] evaluateCandidate — 聚合四重闸门");
{
  // 高质量候选 → pass
  const good = evaluateCandidate(
    {
      title: "中国糖尿病防治指南2024",
      license: "CC-BY-4.0",
      authority: "guideline",
      year: 2024,
      disease: "糖尿病",
    },
    { keywords: ["糖尿病"] },
  );
  ok(good.pass === true, "高质量 → pass");
  ok(good.score > 0, "有综合分");
  ok(good.reasons.length === 4, "4 条理由(许可/权威/时效/相关)");

  // 无许可(NOT OA) → 拒
  const noLic = evaluateCandidate(
    {
      title: "中国糖尿病防治指南2024",
      license: "All Rights Reserved",
      authority: "guideline",
      year: 2024,
      disease: "糖尿病",
    },
    { keywords: ["糖尿病"] },
  );
  ok(noLic.pass === false, "All Rights Reserved → 拒");
  ok(noLic.score === 0, "拒时 score=0");

  // 不相关 → 拒
  const irrel = evaluateCandidate(
    {
      title: "植物学基础研究",
      license: "CC-BY-4.0",
      authority: "paper",
      year: 2024,
      disease: "糖尿病",
    },
    { keywords: ["糖尿病"] },
  );
  ok(irrel.pass === false, "不相关 → 拒");

  // 超龄且干净 → pass 但 flags 含"超龄"
  const oldButClean = evaluateCandidate(
    {
      title: "中国糖尿病防治指南2010",
      license: "CC-BY-4.0",
      authority: "guideline",
      year: 2010,
      disease: "糖尿病",
    },
    { keywords: ["糖尿病"], nowYear: 2026 },
  );
  ok(oldButClean.pass === true, "超龄但许可/权威/相关均好 → pass");
  ok(oldButClean.flags.includes("超龄"), "flags 含超龄");
}

// ─────────────────────────────────────────────
console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
