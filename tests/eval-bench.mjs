// eval-bench.mjs
// 医疗 Agentic RAG 系统 · 端到端评测基准
//
// 目的：量化此前「未量化」的关键指标——指南路由召回率（top1/top3）、语义路由有效性、
//       冷/热（缓存命中）检索延迟与 p95、以及越界查询的精度（不误召回）。
//
// 直接以原生 node 运行（无需 jiti / API Key）：
//   node tests/eval-bench.mjs
//
// 输出：tests/eval-report.json（结构化结果）+ 控制台摘要 + tests/eval-report.html（可视化）。

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { writeFileSync } from "node:fs";
import { routeGuides, loadIndex } from "../.pi/extensions/lib/guide-router.mjs";
import { searchKG, loadGraph } from "../.pi/extensions/lib/kg-search.mjs";
import { cacheClear } from "../.pi/extensions/lib/retrieval-cache.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

const index = loadIndex(REPO_ROOT);
const graph = loadGraph(REPO_ROOT);

// ---------- 1) 自动黄金集：每指南取疾病名作查询，期望 top1=该指南 ----------
const autoGold = Object.entries(index.guideMap).map(([title, info]) => ({
  q: info.disease,
  expected: title,
  kind: "literal",
}));

// ---------- 2) 语义/同义探针：用别名（恶性肿瘤/宫颈恶性肿瘤…）逼迫语义路由 ----------
const semanticProbes = [
  { q: "前列腺恶性肿瘤的治疗", expected: "前列腺癌诊疗指南（2022年版）" },
  { q: "宫颈恶性肿瘤筛查", expected: "宫颈癌诊疗指南（2022年版）" },
  { q: "胃部恶性肿瘤化疗方案", expected: "胃癌诊疗指南（2022年版）" },
  { q: "肝脏恶性肿瘤靶向药", expected: "原发性肝癌诊疗指南（2024年版）" },
  { q: "膀胱恶性肿瘤晚期", expected: "膀胱癌诊疗指南（2022年版）" },
  { q: "胰腺恶性肿瘤黄疸", expected: "胰腺癌诊治指南（2022年版）" },
  { q: "食道恶性肿瘤吞咽困难", expected: "食管癌诊疗指南（2022年版）" },
  { q: "儿童支原体肺炎反复发烧", expected: "儿童肺炎支原体肺炎诊疗指南（2025年版）" },
  { q: "老年髋部骨折怎么处理", expected: "老年髋部骨折诊疗与管理指南（2022年版）" },
  { q: "慢性髓性白血病用药", expected: "慢性髓性白血病诊疗指南（2022年版）" },
  { q: "肥胖症如何减重治疗", expected: "肥胖症诊疗指南（2024年版）" },
  { q: "黑色素瘤转移靶向", expected: "黑色素瘤诊疗指南（2022年版）" },
].map((p) => ({ ...p, kind: "semantic" }));

// ---------- 3) 越界精度探针：不应误召回任何指南 ----------
const oosProbes = [
  { q: "番茄炒蛋怎么做", expected: null, kind: "out-of-scope" },
  { q: "今天天气怎么样", expected: null, kind: "out-of-scope" },
  { q: "怎么用 Python 写快排", expected: null, kind: "out-of-scope" },
];

const all = [...autoGold, ...semanticProbes, ...oosProbes];

// ---------- 运行 + 度量 ----------
cacheClear(); // 确保冷启动基线的纯净

const latencySamples = []; // 路由冷启动耗时
const warmSamples = []; // 缓存命中耗时
const routeResults = [];

let literalTop1 = 0;
let literalTop3 = 0;
let literalN = 0;
let semTop1 = 0;
let semTop3 = 0;
let semN = 0;
let oosOk = 0;
let oosN = 0;

for (const c of all) {
  // 冷调用（清缓存以保证冷）
  const t0 = performance.now();
  const cold = routeGuides(c.q, { index, useCache: false });
  const coldMs = performance.now() - t0;
  latencySamples.push(coldMs);

  // 热调用（写缓存后读）
  routeGuides(c.q, { index, useCache: true }); // 写入
  const t1 = performance.now();
  const warm = routeGuides(c.q, { index, useCache: true });
  const warmMs = performance.now() - t1;
  warmSamples.push(warmMs);

  const top1 = warm.top[0]?.title || null;
  const top3 = warm.top.slice(0, 3).map((g) => g.title);
  const hit1 = top1 === c.expected;
  const hit3 = !!c.expected && top3.includes(c.expected);

  if (c.kind === "out-of-scope") {
    oosN++;
    if (warm.totalMatched === 0) oosOk++;
  } else if (c.kind === "semantic") {
    semN++;
    if (hit1) semTop1++;
    if (hit3) semTop3++;
  } else {
    literalN++;
    if (hit1) literalTop1++;
    if (hit3) literalTop3++;
  }

  routeResults.push({
    q: c.q,
    kind: c.kind,
    expected: c.expected,
    top1,
    top3,
    hit1,
    hit3,
    totalMatched: warm.totalMatched,
    coldMs: +coldMs.toFixed(2),
    warmMs: +warmMs.toFixed(3),
    reasons: top1 ? warm.top[0].reasons : [],
  });
}

// ---------- KG 延迟抽样 ----------
const kgSamples = [];
const kgParams = [
  { disease: "前列腺癌", entityType: "drug" },
  { disease: "胃癌", entityType: "symptom" },
  { disease: "淋巴瘤", entityType: "" },
];
for (const p of kgParams) {
  const a = performance.now();
  searchKG(p, { graph, useCache: false });
  const cold = performance.now() - a;
  searchKG(p, { graph, useCache: true });
  const b = performance.now();
  searchKG(p, { graph, useCache: true });
  const warm = performance.now() - b;
  kgSamples.push({ params: p, coldMs: +cold.toFixed(2), warmMs: +warm.toFixed(3), count: 1 });
}

// ---------- 聚合指标 ----------
function pct(a, b) {
  return b === 0 ? 0 : +((a / b) * 100).toFixed(1);
}
function percentile(arr, p) {
  if (!arr.length) return 0;
  const s = [...arr].sort((x, y) => x - y);
  const idx = Math.min(s.length - 1, Math.floor((p / 100) * s.length));
  return +s[idx].toFixed(3);
}
const avg = (a) => (a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(3) : 0);

const metrics = {
  generatedAt: new Date().toISOString(),
  knowledgeBase: {
    guides: Object.keys(index.guideMap).length,
    keywords: index.totalKeywords,
    kgEntities: graph.length,
  },
  routing: {
    literal: { n: literalN, top1: literalTop1, top3: literalTop3, top1Rate: pct(literalTop1, literalN), top3Rate: pct(literalTop3, literalN) },
    semantic: { n: semN, top1: semTop1, top3: semTop3, top1Rate: pct(semTop1, semN), top3Rate: pct(semTop3, semN) },
    outOfScope: { n: oosN, precisionOk: oosOk, precisionRate: pct(oosOk, oosN) },
  },
  latency: {
    routeCold: { avgMs: avg(latencySamples), p95Ms: percentile(latencySamples, 95), maxMs: Math.max(...latencySamples).toFixed(2) },
    routeWarm: { avgMs: avg(warmSamples), p95Ms: percentile(warmSamples, 95) },
    kgCold: { avgMs: avg(kgSamples.map((s) => s.coldMs)), p95Ms: percentile(kgSamples.map((s) => s.coldMs), 95) },
    kgWarm: { avgMs: avg(kgSamples.map((s) => s.warmMs)), p95Ms: percentile(kgSamples.map((s) => s.warmMs), 95) },
  },
};

const report = { metrics, details: routeResults, kgSamples };
writeFileSync(join(REPO_ROOT, "tests", "eval-report.json"), JSON.stringify(report, null, 2), "utf-8");

// ---------- 控制台摘要 ----------
const line = "─".repeat(64);
console.log(line);
console.log("医疗 Agentic RAG · 端到端评测基线");
console.log(line);
console.log(`知识库: ${metrics.knowledgeBase.guides} 指南 / ${metrics.knowledgeBase.keywords} 关键词 / ${metrics.knowledgeBase.kgEntities} 图谱实体`);
console.log(line);
console.log(`路由召回 (字面/${literalN}):  top1=${metrics.routing.literal.top1Rate}%  top3=${metrics.routing.literal.top3Rate}%`);
console.log(`路由召回 (语义/${semN}):  top1=${metrics.routing.semantic.top1Rate}%  top3=${metrics.routing.semantic.top3Rate}%`);
console.log(`越界精度 (${oosN}):        ${metrics.routing.outOfScope.precisionRate}%`);
console.log(line);
console.log(`路由延迟 冷: 均值 ${metrics.latency.routeCold.avgMs}ms / p95 ${metrics.latency.routeCold.p95Ms}ms`);
console.log(`路由延迟 热: 均值 ${metrics.latency.routeWarm.avgMs}ms / p95 ${metrics.latency.routeWarm.p95Ms}ms`);
console.log(`图谱延迟 冷: 均值 ${metrics.latency.kgCold.avgMs}ms / p95 ${metrics.latency.kgCold.p95Ms}ms`);
console.log(`图谱延迟 热: 均值 ${metrics.latency.kgWarm.avgMs}ms / p95 ${metrics.latency.kgWarm.p95Ms}ms`);
console.log(line);
console.log("逐条明细:");
for (const r of routeResults) {
  const tag = r.hit1 ? "✓" : r.kind === "out-of-scope" ? (r.totalMatched === 0 ? "✓" : "✗") : "✗";
  console.log(`  ${tag} [${r.kind}] ${r.q}`);
  if (!r.hit1 && r.kind !== "out-of-scope") {
    console.log(`     期望: ${r.expected}`);
    console.log(`     实际top1: ${r.top1}  top3: ${r.top3.join(" | ")}`);
    console.log(`     依据: ${r.reasons.join("；")}`);
  }
}
console.log(line);
console.log(`报告已写出: tests/eval-report.json`);

// ---------- 轻量 HTML 可视化 ----------
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>医疗 Agentic RAG · 评测基线</title>
<style>
body{font-family:-apple-system,Segoe UI,Roboto,'Microsoft YaHei',sans-serif;background:#0f1419;color:#e6edf3;margin:0;padding:32px;}
h1{font-size:22px;margin:0 0 4px}
.sub{color:#8b949e;font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:#161b22;border:1px solid #30363d;border-radius:12px;padding:18px}
.card .k{color:#8b949e;font-size:12px}
.card .v{font-size:28px;font-weight:700;margin-top:6px}
.bar{height:8px;border-radius:4px;background:#30363d;margin-top:10px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,#3fb950,#2ea043)}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px}
th,td{text-align:left;padding:8px 10px;border-bottom:1px solid #21262d}
th{color:#8b949e;font-weight:500}
.ok{color:#3fb950}.bad{color:#f85149}
</style></head><body>
<h1>医疗 Agentic RAG · 评测基线</h1>
<div class="sub">生成时间 ${metrics.generatedAt} · 知识库 ${metrics.knowledgeBase.guides} 指南 / ${metrics.knowledgeBase.keywords} 关键词 / ${metrics.knowledgeBase.kgEntities} 实体</div>
<div class="grid">
  <div class="card"><div class="k">字面路由 top1</div><div class="v">${metrics.routing.literal.top1Rate}%</div><div class="bar"><i style="width:${metrics.routing.literal.top1Rate}%"></i></div></div>
  <div class="card"><div class="k">语义路由 top1</div><div class="v">${metrics.routing.semantic.top1Rate}%</div><div class="bar"><i style="width:${metrics.routing.semantic.top1Rate}%"></i></div></div>
  <div class="card"><div class="k">字面路由 top3</div><div class="v">${metrics.routing.literal.top3Rate}%</div><div class="bar"><i style="width:${metrics.routing.literal.top3Rate}%"></i></div></div>
  <div class="card"><div class="k">越界精度</div><div class="v">${metrics.routing.outOfScope.precisionRate}%</div><div class="bar"><i style="width:${metrics.routing.outOfScope.precisionRate}%"></i></div></div>
  <div class="card"><div class="k">路由冷延迟 p95</div><div class="v">${metrics.latency.routeCold.p95Ms}ms</div></div>
  <div class="card"><div class="k">路由热延迟 p95</div><div class="v">${metrics.latency.routeWarm.p95Ms}ms</div></div>
</div>
<table><thead><tr><th>结果</th><th>类型</th><th>查询</th><th>期望</th><th>实际 top1</th><th>冷/热(ms)</th></tr></thead><tbody>
${routeResults
  .map((r) => {
    const ok = r.hit1 || (r.kind === "out-of-scope" && r.totalMatched === 0);
    return `<tr><td class="${ok ? "ok" : "bad"}">${ok ? "✓" : "✗"}</td><td>${r.kind}</td><td>${r.q}</td><td>${r.expected || "—"}</td><td>${r.top1 || "无"}</td><td>${r.coldMs}/${r.warmMs}</td></tr>`;
  })
  .join("")}
</tbody></table>
</body></html>`;
writeFileSync(join(REPO_ROOT, "tests", "eval-report.html"), html, "utf-8");
console.log(`可视化已写出: tests/eval-report.html`);
console.log(line);
