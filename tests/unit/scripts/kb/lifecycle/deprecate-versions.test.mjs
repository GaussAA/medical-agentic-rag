// deprecate-versions-test.mjs
// deprecate-versions.mjs 纯函数单测 —— 验证括号去重 + 版本检测逻辑。
// 合成 guide 数据，零文件 IO，零网络，可进 CI。
// 运行: node tests/unit/deprecate-versions-test.mjs

import { detectBracketDups, detectDeprecations } from "../../../../../scripts/kb/lifecycle/deprecate-versions.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.error("  ✗", name, detail); }
}

console.log("\n=== deprecate-versions 单测 ===\n");

// ─────────────────────────────────────────────
console.log("[1] detectBracketDups — 括号去重");
{
  const guides = [
    { title: "中国高血压防治指南(2024年修订版)" },
    { title: "中国高血压防治指南（2024年修订版）" }, // 全角括号 → 重复
    { title: "糖尿病防治指南（2024版）" },
    { title: "糖尿病防治指南(2024版)" }, // 全角/半角 → 重复
    { title: "原发性肝癌诊疗指南（2024年版）" },
  ];

  const dups = detectBracketDups(guides);
  ok(dups.length === 2, `检测到 2 组括号重复（实际 ${dups.length}）`);
  ok(dups.some((d) => d.keep.title.includes("高血压") && d.remove.title.includes("高血压")), "高血压括号重复");
  ok(dups.some((d) => d.keep.title.includes("糖尿病") && d.remove.title.includes("糖尿病")), "糖尿病括号重复");
  ok(!dups.some((d) => d.keep.title.includes("肝癌")), "肝癌不重复");
}

// ─────────────────────────────────────────────
console.log("\n[2] detectBracketDups — 无重复");
{
  const dups = detectBracketDups([
    { title: "指南A(2024版)" },
    { title: "指南B(2025版)" },
    { title: "指南C（2024年版）" },
  ]);
  ok(dups.length === 0, "无重复返回空");
  ok(Array.isArray(dups), "返回数组");
}

// ─────────────────────────────────────────────
console.log("\n[3] detectBracketDups — 空输入");
{
  ok(detectBracketDups([]).length === 0, "空数组");
  ok(detectBracketDups([{ title: "" }]).length === 0, "含空标题");
}

// ─────────────────────────────────────────────
console.log("\n[4] detectDeprecations — 版本检测（2023→2025）");
{
  const dep = detectDeprecations([
    { title: "儿童肺炎支原体肺炎诊疗指南（2023年版）" },
    { title: "儿童肺炎支原体肺炎诊疗指南（2025年版）" },
  ]);
  ok(dep.length === 1, "检测到 1 组版本替代");
  ok(dep[0].oldVersion === 2023, "旧版本 2023");
  ok(dep[0].newVersion === 2025, "新版本 2025");
  ok(dep[0].oldTitle.includes("2023"), "旧标题含 2023");
  ok(dep[0].newTitle.includes("2025"), "新标题含 2025");
}

// ─────────────────────────────────────────────
console.log("\n[5] detectDeprecations — 多级版本（2022→2024→2026）");
{
  const dep = detectDeprecations([
    { title: "原发性肝癌诊疗指南（2022年版）" },
    { title: "原发性肝癌诊疗指南（2024年版）" },
    { title: "原发性肝癌诊疗指南（2026版）" },
  ]);
  ok(dep.length === 2, "三级版本 → 2 组替代（2022→2026, 2024→2026）");
  ok(dep.some((d) => d.oldVersion === 2022 && d.newVersion === 2026), "2022→2026");
  ok(dep.some((d) => d.oldVersion === 2024 && d.newVersion === 2026), "2024→2026");
}

// ─────────────────────────────────────────────
console.log("\n[6] detectDeprecations — 仅单版本无过期");
{
  const dep = detectDeprecations([
    { title: "黑色素瘤诊疗指南（2022年版）" },
  ]);
  ok(dep.length === 0, "单版本 → 无替代");
}

// ─────────────────────────────────────────────
console.log("\n[7] detectDeprecations — 同版本不同括号不误报");
{
  const dep = detectDeprecations([
    { title: "某指南(2024版)" },
    { title: "某指南（2024年版）" }, // 同版本不同括号
  ]);
  ok(dep.length === 0, "同版本不同括号 → 无替代");
}

// ─────────────────────────────────────────────
console.log("\n[8] detectDeprecations — 不同疾病不分组");
{
  const dep = detectDeprecations([
    { title: "肺癌诊疗指南（2022年版）" },
    { title: "肝癌诊疗指南（2024年版）" },
  ]);
  ok(dep.length === 0, "不同疾病 → 不跨组替代");
}

// ─────────────────────────────────────────────
console.log("\n[9] detectDeprecations — 空/缺省输入");
{
  ok(detectDeprecations([]).length === 0, "空数组");
  ok(detectDeprecations([{ title: "指南" }]).length === 0, "无版本号的指南");
}

// ─────────────────────────────────────────────
console.log("\n[10] detectDeprecations — 括号归一化一致性");
{
  // 全角/半角混合的版本号应归一后正确匹配
  const dep = detectDeprecations([
    { title: "新型抗肿瘤药物临床应用指导原则(2022年版)" },
    { title: "新型抗肿瘤药物临床应用指导原则（2025年版）" },
  ]);
  ok(dep.length === 1, "半角→全角括号版本号匹配");
  ok(dep[0].oldVersion === 2022, "正确识别 2022 版");
  ok(dep[0].newVersion === 2025, "正确识别 2025 版");
}

// ─────────────────────────────────────────────
console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
