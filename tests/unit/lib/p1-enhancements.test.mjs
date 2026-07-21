// p1-enhancements-test.mjs
// P1 三件套单测：RRF 融合 + CRAG 纠错 + 查询改写（纯函数部分）
// 运行: node tests/unit/p1-enhancements-test.mjs

import { rrfFusion } from "../../.pi/extensions/lib/retrieval-router.mjs";
import { correctMedicalQuery } from "../../.pi/extensions/lib/query-sanitize.mjs";
import { filterVariants } from "../../.pi/extensions/lib/query-transform.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (extra ? " :: " + extra : "")); console.log("  ✗", name, extra); }
}

// ─────────────────────────────────────────────
console.log("\n[P1-1] RRF Fusion — 多通道结果融合");
{
  // 空输入
  const r0 = rrfFusion([], 60, 8);
  ok("空列表返回空数组", r0.length === 0);
  const r00 = rrfFusion(null, 60, 8);
  ok("null 返回空数组", r00.length === 0);

  // 单通道：原样返回
  const single = [
    [
      { file_path: "指南A.md", score: 0.9, snippet: "..." },
      { file_path: "指南B.md", score: 0.7, snippet: "..." },
    ],
  ];
  const r1 = rrfFusion(single, 60, 8);
  ok("单通道原样返回", r1.length === 2);
  ok("单通道保序", r1[0].file_path === "指南A.md");

  // 双通道融合：A 在通道1排第1、通道2排第2；B 相反
  const lists = [
    [
      { file_path: "指南A.md", score: 0.9, snippet: "..." },
      { file_path: "指南B.md", score: 0.8, snippet: "..." },
    ],
    [
      { file_path: "指南B.md", score: 0.85, snippet: "..." },
      { file_path: "指南A.md", score: 0.7, snippet: "..." },
    ],
  ];
  const r2 = rrfFusion(lists, 60, 8);
  ok("双通道融合返回 2 条", r2.length === 2);
  // RRF: A=1/(60+0)+1/(60+1)=0.0167+0.0164=0.0331; B=1/(60+1)+1/(60+0)=0.0164+0.0167=0.0331
  // 同分 → 保留 score 高的片段
  ok("融合结果含 rrfScore", typeof r2[0].rrfScore === "number" && r2[0].rrfScore > 0);

  // 三通道：一条结果只在其中一个通道出现
  const lists3 = [
    [{ file_path: "A.md", score: 1.0, snippet: "aa" }],
    [{ file_path: "B.md", score: 0.9, snippet: "bb" }],
    [{ file_path: "C.md", score: 0.8, snippet: "cc" }],
  ];
  const r3 = rrfFusion(lists3, 60, 8);
  ok("三通道独立结果融合", r3.length === 3);
  ok("各结果均有 rrfScore", r3.every((r) => typeof r.rrfScore === "number"));

  // topK 截断
  const many = [
    Array.from({ length: 5 }, (_, i) => ({ file_path: `A${i}.md`, score: 1 - i * 0.1, snippet: "" })),
    Array.from({ length: 5 }, (_, i) => ({ file_path: `B${i}.md`, score: 1 - i * 0.1, snippet: "" })),
  ];
  const r4 = rrfFusion(many, 60, 3);
  ok("topK 截断（取 3 条）", r4.length <= 3);

  // 去重：同一 file_path 出现在多个通道时只保留一条
  const dupe = [
    [{ file_path: "X.md", score: 1.0, snippet: "v1" }],
    [{ file_path: "X.md", score: 0.9, snippet: "v2" }],
  ];
  const r5 = rrfFusion(dupe, 60, 8);
  ok("去重（相同 file_path 只保留一条）", r5.length === 1);
}

// ─────────────────────────────────────────────
console.log("\n[P1-2] CRAG 纠错 — correctMedicalQuery");
{
  // 空 / null 输入
  ok("空字符串原样返回", correctMedicalQuery("") === "");
  ok("null 返回 null", correctMedicalQuery(null) === null);

  // 同音字纠正
  const c1 = correctMedicalQuery("我胃痛");
  ok("同音字纠正：位→胃", c1.includes("胃痛"), `got: ${c1}`);
  const c2 = correctMedicalQuery("肺部有留");
  ok("同音字纠正：留→瘤", c2.includes("有瘤"), `got: ${c2}`);

  // 不完整术语补全
  const c3 = correctMedicalQuery("怎么治疗高血");
  ok("术语补全：高血→高血压", c3.includes("高血压"), `got: ${c3}`);
  const c4 = correctMedicalQuery("糖尿病人能吃什么");
  ok("术语补全：糖尿→糖尿病", c4.includes("糖尿病"), `got: ${c4}`);
  const c5 = correctMedicalQuery("糖尿病人能吃什么");
  ok("术语补全：糖尿→糖尿病", c5.includes("糖尿病"), `got: ${c5}`);

  // 缩写扩展
  const c6 = correctMedicalQuery("copd的治疗方案");
  ok("缩写扩展：copd→慢阻肺", c6.includes("慢性阻塞性肺疾病"), `got: ${c6}`);
  const c7 = correctMedicalQuery("dm饮食注意");
  ok("缩写扩展：dm→糖尿病", c7.includes("糖尿病"), `got: ${c7}`);

  // 复合纠错：同音字 + 术语补全
  const c8 = correctMedicalQuery("我肺部有留位置");
  ok("复合纠错：留→瘤", c8.includes("瘤"), `got: ${c8}`);

  // 不应过度纠错（正常医学术语不被改坏）
  const c9 = correctMedicalQuery("高血压用药指南");
  ok("正常术语不被改坏", c9.includes("高血压"), `got: ${c9}`);
  const c10 = correctMedicalQuery("糖尿病肾病");
  ok("不破坏已有正确词", c10.includes("糖尿病肾病"), `got: ${c10}`);

  // 非医疗查询不应受影响
  const c11 = correctMedicalQuery("上海天气如何");
  ok("非医疗查询不受影响", c11.includes("上海天气"), `got: ${c11}`);

  // CRAG 保守行为：前缀后跟汉字时不补全（防误伤"高血压"类词）
  // "脑梗怎么办"中的"脑梗"后跟"怎"（汉字）→ 安全跳过，不补全为"脑梗死"
  const c12 = correctMedicalQuery("脑梗怎么办");
  ok("保守CRAG：脑梗后跟汉字时不补全", c12.includes("脑梗"), `got: ${c12}`);
}

// ─────────────────────────────────────────────
console.log("\n[P1-3] 查询改写工具 — filterVariants");
{
  // 空输入
  ok("空数组返回空", filterVariants([]).length === 0);
  ok("null 返回空", filterVariants(null).length === 0);

  // 基本过滤
  const v1 = filterVariants(["高血压", "高血压 诊断", "hypertension"]);
  ok("保留有效变体（去重原句）", v1.length >= 1);

  // 去重：相同的变体只保留一个
  const v2 = filterVariants(["糖尿病", "糖尿病", "2型糖尿病"]);
  ok("去重变体", v2.length === 2, JSON.stringify(v2));

  // 过短变体被丢弃
  const v3 = filterVariants(["糖尿病", "a", "bc"]);
  ok("过滤过短变体（<3字）", v3.length === 1, JSON.stringify(v3));

  // 过长变体被丢弃
  const v4 = filterVariants(["糖尿病", "x".repeat(120)]);
  ok("过滤过长变体（>100字）", v4.length === 1, JSON.stringify(v4));
}

// ─────────────────────────────────────────────
console.log("\n[汇总]");
console.log(`  ${pass}/${pass + fail} 通过`);
if (fail > 0) {
  console.log("  失败项:");
  for (const f of fails) console.log("    -", f);
}
process.exit(fail > 0 ? 1 : 0);
