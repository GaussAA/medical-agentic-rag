// retrieval-router-test.mjs
// 定向召回库单测：纯函数 + 真实 knowledge.db 端到端编排。
// 运行: node tests/retrieval-router-test.mjs

import {
  resolveKbFiles,
  makeSnippet,
  lexicalSearch,
  searchKnowledge,
  setKbDb,
  loadKbFilenames,
  Database,
} from "../../.pi/extensions/lib/retrieval-router.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    fails.push(name + (extra ? " :: " + extra : ""));
    console.log("  ✗", name, extra);
  }
}

// ─────────────────────────────────────────────
console.log("\n[1] resolveKbFiles — 路由标题 → KB 文件名映射");
{
  const kb = [
    "前列腺癌诊疗指南（2022年版）.md",
    "老年髋部骨折诊疗与管理指南（2022年版）.md",
    "中国人群骨质疏松症风险管理公众指南（2024）.md",
  ];
  // 完全匹配（含 .md）
  const r1 = resolveKbFiles(["中国人群骨质疏松症风险管理公众指南（2024）"], kb);
  ok("完全匹配(标题无.md)", r1.length === 1 && r1[0].includes("骨质疏松症"), JSON.stringify(r1));

  // 标题已带 .md
  const r2 = resolveKbFiles(["前列腺癌诊疗指南（2022年版）.md"], kb);
  ok("标题已带 .md", r2.length === 1 && r2[0].startsWith("前列腺癌"), JSON.stringify(r2));

  // 双向子串（文件名被截断场景）
  const kb2 = ["前列腺癌诊疗指南.md"];
  const r3 = resolveKbFiles(["前列腺癌诊疗指南（2022年版）"], kb2);
  ok("双向子串容错", r3.length === 1 && r3[0] === "前列腺癌诊疗指南.md", JSON.stringify(r3));

  // 去重 + 保序
  const r4 = resolveKbFiles(
    ["前列腺癌诊疗指南（2022年版）", "前列腺癌诊疗指南（2022年版）.md"],
    kb,
  );
  ok("去重", r4.length === 1, JSON.stringify(r4));

  // 未命中返回空
  const r5 = resolveKbFiles(["不存在的指南"], kb);
  ok("无命中返回空", r5.length === 0);
}

// ─────────────────────────────────────────────
console.log("\n[2] makeSnippet — 摘要抽取");
{
  const content = "骨质疏松症是一种以骨量低下、骨微结构破坏为特征的全身性骨病。双膦酸盐可用于骨折预防。";
  const s1 = makeSnippet(content, ["双膦酸盐"]);
  ok("命中词元被纳入摘要", s1.includes("双膦酸盐"), s1);
  const s2 = makeSnippet("", ["x"]);
  ok("空内容返回空串", s2 === "");
  const s3 = makeSnippet("短文本", ["不存在"]);
  ok("无命中回退到开头", s3.includes("短文本"));
}

// ─────────────────────────────────────────────
console.log("\n[3] lexicalSearch — 临时 DB BM25（约束 vs 全语料）");
const tmp = new Database(":memory:");
tmp.exec(
  "CREATE TABLE chunks (id INTEGER PRIMARY KEY, file_path TEXT, content TEXT, metadata_json TEXT)",
);
const insert = tmp.prepare("INSERT INTO chunks (file_path, content) VALUES (?, ?)");
insert.run("前列腺癌诊疗指南（2022年版）.md", "前列腺癌的药物治疗包括内分泌治疗与化疗；双膦酸盐用于骨转移并发症管理。");
insert.run("老年髋部骨折诊疗与管理指南（2022年版）.md", "老年髋部骨折围手术期管理，注意跌倒预防与营养支持。");
insert.run("中国人群骨质疏松症风险管理公众指南（2024）.md", "骨质疏松症的风险评估方法；双膦酸盐是一类抗骨质疏松药物，用于骨折预防。");
setKbDb(tmp);

{
  const osteo = "中国人群骨质疏松症风险管理公众指南（2024）.md";
  const pros = "前列腺癌诊疗指南（2022年版）.md";

  // 约束到骨质疏松文件 → 只返回该文件
  const c = lexicalSearch(tmp, "骨质疏松 双膦酸盐", { kbFiles: [osteo] });
  ok("约束检索仅含目标文件", c.length >= 1 && c.every((r) => r.file_path === osteo), JSON.stringify(c.map(r=>r.file_path)));
  ok("约束检索命中分数>0", c.length >= 1 && c[0].score > 0);

  // 全语料 → 骨质疏松应排在前列（同时含 骨质疏松+双膦酸盐），压过仅含 双膦酸盐 的前列腺癌
  const all = lexicalSearch(tmp, "骨质疏松 双膦酸盐", {});
  ok("全语料检索至少命中2条", all.length >= 2, JSON.stringify(all.map(r=>r.file_path)));
  ok("骨质疏松排在同含词元的前列腺癌之前", all[0].file_path === osteo, JSON.stringify(all.map(r=>r.file_path)));

  // 仅前列腺癌相关词 → 前列腺癌排第一
  const p = lexicalSearch(tmp, "前列腺癌 内分泌治疗", { kbFiles: [pros] });
  ok("约束前列腺癌文件命中", p.length >= 1 && p[0].file_path === pros, JSON.stringify(p.map(r=>r.file_path)));

  // 空查询
  ok("空查询返回空", lexicalSearch(tmp, "   ", {}) .length === 0);

  // 路由指南全不在临时 KB → 退化为全语料（不丢召回）
  const fb = searchKnowledge("糖尿病 血糖 管理", { limit: 5 });
  ok("路由指南全不在KB → 退化全语料(constrained=false)", fb.constrained === false, JSON.stringify({constrained:fb.constrained}));
  ok("退化时仍返回数组(不崩溃)", Array.isArray(fb.results));
}

// ─────────────────────────────────────────────
console.log("\n[4] searchKnowledge — 真实 knowledge.db 端到端");
const REAL = (() => {
  const env = process.env.PI_KNOWLEDGE_DIR || process.env.PICODING_KNOWLEDGE_DIR;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const p = env ? env + "/knowledge.db" : home + "/.pi/knowledge/knowledge.db";
  return p;
})();
import { existsSync } from "node:fs";
if (!existsSync(REAL)) {
  console.log("  (跳过：真实 knowledge.db 不存在)");
} else {
  setKbDb(REAL);
  const allFiles = loadKbFilenames(new Database(REAL, { readonly: true }));
  console.log(`  真实 KB 文件数: ${allFiles.length}`);

  // 前列腺癌指南在 KB 30 份内 → 应约束命中
  const r1 = searchKnowledge("前列腺癌 双膦酸盐", { limit: 5 });
  ok("前列腺癌查询路由命中 KB 文件", r1.constrained === true, JSON.stringify(r1.kbFiles));
  ok("前列腺癌查询 top1 即约束文件", r1.results.length > 0 && r1.results[0].file_path.includes("前列腺癌"), r1.results[0]?.file_path);

  // KB 重建为 132 份后，骨质疏松公众指南本身已入库 → 路由命中真实指南并约束到该文件
  const r2 = searchKnowledge("骨质疏松 治疗", { limit: 5 });
  ok("骨质疏松查询约束到相关的索引内指南", r2.constrained === true, JSON.stringify({constrained:r2.constrained, kb:r2.kbFiles}));
  ok("骨质疏松查询 top1 为约束的骨健康指南", r2.results.length > 0 && r2.results[0].file_path.includes("骨质疏松"), r2.results[0]?.file_path);
  ok("骨质疏松查询仍返回结果", Array.isArray(r2.results) && r2.results.length > 0, "");

  // ── kb_id 解析回归（修复：传入人类可读名"医疗指南"曾被当作 UUID 过滤 → 0 行召回全空）──
  const r3 = searchKnowledge("前列腺癌 双膦酸盐", { limit: 5, kbId: "医疗指南" });
  ok("kb_id 传人类可读名(医疗指南) 解析为真实 UUID 并召回", r3.results.length > 0, "results=" + r3.results.length);
  const r4 = searchKnowledge("前列腺癌 双膦酸盐", { limit: 5, kbId: "不存在的库" });
  ok("kb_id 传未知名字 → 跳过过滤不丢召回", r4.results.length > 0, "results=" + r4.results.length);
  const uuid = new Database(REAL, { readonly: true }).prepare("SELECT DISTINCT kb_id FROM chunks LIMIT 1").get().kb_id;
  const r5 = searchKnowledge("前列腺癌 双膦酸盐", { limit: 5, kbId: uuid });
  ok("kb_id 传真实 UUID 正常召回", r5.results.length > 0, "results=" + r5.results.length);

  // 语义路由本身能识别骨质疏松指南
  const idx = (await import("../../.pi/extensions/lib/guide-router.mjs")).loadIndex();
  const routed = (await import("../../.pi/extensions/lib/guide-router.mjs")).routeGuides("骨质疏松", { index: idx });
  const hitOsteo = routed.top.some((g) => g.title.includes("骨质疏松"));
  ok("语义路由正确识别骨质疏松指南", hitOsteo, JSON.stringify(routed.top.map(g=>g.title).slice(0,3)));
}

// ─────────────────────────────────────────────
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
