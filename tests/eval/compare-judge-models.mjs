/**
 * 评测模型对比工具
 *
 * 用 deepseek-v4-flash（经 sensenova 免费通道）重新评测 65 条黄金答案，
 * 与 baseline.json 中 sensenova-6.7-flash-lite 的评分对比，输出 HTML 报告。
 *
 * 用法：
 *   LLM_JUDGE_MODEL=sensenova/deepseek-v4-flash node tests/eval/compare-judge-models.mjs
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const BASELINE_PATH = join(ROOT, "tests", "reports", "baseline.json");
const REPORT_PATH = join(ROOT, "tests", "reports", "judge-model-comparison.html");

// ── 载入黄金答案 ──
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
const items = gold.items || [];
console.log(`黄金答案集: ${items.length} 条`);

// ── 读取基线（sensenova 旧评分） ──
const baselineDetail = {};
if (existsSync(BASELINE_PATH)) {
  const bl = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  if (Array.isArray(bl.details)) {
    for (const d of bl.details) {
      if (d.id && d.llmJudge) baselineDetail[d.id] = d.llmJudge;
    }
  }
}
console.log(`基线数据: ${Object.keys(baselineDetail).length} 条有 LLM-Judge 评分`);

// ── 动态导入 llm-judge（此时 LLM_JUDGE_MODEL 已生效） ──
const { judgeAnswer, runWithConcurrency } = await import("../../.pi/extensions/lib/llm-judge.mjs");

// ── 批量评测 ──
const tasks = items.map((item) => async () => {
  const result = await judgeAnswer({
    question: item.q,
    answer: item.systemAnswer || item.referenceAnswer,
    referenceAnswer: item.referenceAnswer,
    gtSources: item.gtSources || [],
  });
  return { id: item.id, department: item.department, difficulty: item.difficulty, question: item.q.slice(0, 40), ...result };
});

console.log(`\n开始评测 ${tasks.length} 条...`);
// deepseek 免费通道有 RPM 限制（sensenova 平台），用低并发 + 退避确保不超限
const deepseekResults = await runWithConcurrency(tasks, 2);

// ── 统计对比 ──
let dsTotal = { faith: 0, rel: 0, clin: 0, saf: 0 };
let dsSkipped = 0;
let snTotal = { faith: 0, rel: 0, clin: 0, saf: 0 };
let snSkipped = 0;

const comparisons = [];

for (const r of deepseekResults) {
  if (r.skipped) { dsSkipped++; continue; }
  dsTotal.faith += r.faithfulness;
  dsTotal.rel += r.answerRelevance;
  dsTotal.clin += r.clinicalCorrectness;
  dsTotal.saf += r.safety;

  const bl = baselineDetail[r.id] || {};
  const snFaith = bl.faithfulness;
  const snRel = bl.answerRelevance;
  const snClin = bl.clinicalCorrectness;
  const snSaf = bl.safety;

  if (snFaith != null) snSkipped++;
  if (snFaith != null) snTotal.faith += snFaith;
  if (snRel != null) snTotal.rel += snRel;
  if (snClin != null) snTotal.clin += snClin;
  if (snSaf != null) snTotal.saf += snSaf;

  comparisons.push({
    id: r.id, department: r.department, difficulty: r.difficulty,
    question: r.question,
    ds: { faith: r.faithfulness, rel: r.answerRelevance, clin: r.clinicalCorrectness, saf: r.safety },
    sn: { faith: snFaith, rel: snRel, clin: snClin, saf: snSaf },
    diff: snFaith != null ? {
      faith: r.faithfulness - snFaith,
      rel: r.answerRelevance - snRel,
      clin: r.clinicalCorrectness - snClin,
      saf: r.safety - snSaf,
    } : null,
    dsReasons: r.reasons || "",
  });
}

const dsCount = deepseekResults.filter((r) => !r.skipped).length;
const avg = (t, n) => (n > 0 ? (t / n) : 0).toFixed(3);

console.log(`\n===== 对比报告 =====`);
console.log(`DeepSeek: ${dsCount} 条成功, ${dsSkipped} 条跳过`);
console.log(`  忠实度: ${avg(dsTotal.faith, dsCount)}`);
console.log(`  相关性: ${avg(dsTotal.rel, dsCount)}`);
console.log(`  临床正确性: ${avg(dsTotal.clin, dsCount)}`);
console.log(`  安全性: ${avg(dsTotal.saf, dsCount)}`);

if (snSkipped > 0) {
  // 只统计基线中有评分的题目
  const matched = comparisons.filter((c) => c.sn.faith != null);
  const m = matched.length;
  const snAvgF = matched.reduce((s, c) => s + c.sn.faith, 0) / m;
  const snAvgR = matched.reduce((s, c) => s + c.sn.rel, 0) / m;
  const snAvgC = matched.reduce((s, c) => s + c.sn.clin, 0) / m;
  const snAvgS = matched.reduce((s, c) => s + c.sn.saf, 0) / m;
  const dsAvgF = matched.reduce((s, c) => s + c.ds.faith, 0) / m;
  const dsAvgR = matched.reduce((s, c) => s + c.ds.rel, 0) / m;
  const dsAvgC = matched.reduce((s, c) => s + c.ds.clin, 0) / m;
  const dsAvgS = matched.reduce((s, c) => s + c.ds.saf, 0) / m;

  console.log(`\n同一 ${m} 题对比（均含基线评分）:`);
  console.log(`              SenseNova    DeepSeek    差值`);
  console.log(`  忠实度:     ${snAvgF.toFixed(3)}      ${dsAvgF.toFixed(3)}      ${(dsAvgF - snAvgF).toFixed(3)}`);
  console.log(`  相关性:     ${snAvgR.toFixed(3)}      ${dsAvgR.toFixed(3)}      ${(dsAvgR - snAvgR).toFixed(3)}`);
  console.log(`  临床正确性: ${snAvgC.toFixed(3)}      ${dsAvgC.toFixed(3)}      ${(dsAvgC - snAvgC).toFixed(3)}`);
  console.log(`  安全性:     ${snAvgS.toFixed(3)}      ${dsAvgS.toFixed(3)}      ${(dsAvgS - snAvgS).toFixed(3)}`);
}

// ── 找出差异最大（降分最多）的题目 ──
const sortedByDrop = comparisons
  .filter((c) => c.diff)
  .sort((a, b) => (a.diff?.faith || 0) - (b.diff?.faith || 0))
  .slice(0, 10);

console.log(`\n忠实度降幅最大的 10 题（DeepSeek 评分更严格）:`);
for (const c of sortedByDrop) {
  console.log(`  ${c.id} [${c.department}] ${c.question}: SN=${c.sn.faith.toFixed(2)} → DS=${c.ds.faith.toFixed(2)} (Δ${(c.diff?.faith || 0).toFixed(2)})`);
  console.log(`    原因: ${(c.dsReasons || "").slice(0, 80)}`);
}

const sortedByRise = comparisons
  .filter((c) => c.diff)
  .sort((a, b) => (b.diff?.faith || 0) - (a.diff?.faith || 0))
  .slice(0, 5);

console.log(`\n忠实度升幅最大的 5 题（DeepSeek 更认可）:`);
for (const c of sortedByRise) {
  console.log(`  ${c.id} [${c.department}] ${c.question}: SN=${c.sn.faith.toFixed(2)} → DS=${c.ds.faith.toFixed(2)} (Δ${(c.diff?.faith || 0).toFixed(2)})`);
}

// ── 输出 HTML 报告 ──
function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>评测模型对比报告</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; max-width: 1200px; margin: 0 auto; padding: 20px; background: #f8f9fa; color: #222; }
  h1 { font-size: 22px; font-weight: 600; margin-bottom: 4px; }
  .sub { color: #666; font-size: 13px; margin-bottom: 20px; }
  .summary { display: flex; gap: 16px; flex-wrap: wrap; margin-bottom: 24px; }
  .card { background: #fff; border-radius: 10px; padding: 16px 20px; flex: 1; min-width: 180px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .card h3 { margin: 0 0 8px; font-size: 13px; color: #666; font-weight: 500; }
  .card .val { font-size: 28px; font-weight: 600; }
  .card .val.sn { color: #378ADD; }
  .card .val.ds { color: #7F77DD; }
  .card .delta { font-size: 13px; margin-top: 4px; }
  .up { color: #639922; }
  .down { color: #D85A30; }
  table { width: 100%; border-collapse: collapse; background: #fff; border-radius: 10px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); font-size: 13px; }
  th { background: #f1f3f5; text-align: left; padding: 10px 12px; font-weight: 500; color: #444; }
  td { padding: 8px 12px; border-top: 1px solid #eee; }
  tr:hover td { background: #f8f9ff; }
  .bar { display: inline-block; height: 8px; border-radius: 4px; margin-right: 6px; }
  .bar.sn { background: #378ADD; }
  .bar.ds { background: #7F77DD; }
  .bar-cell { display: flex; align-items: center; gap: 4px; }
  .tag { display: inline-block; font-size: 11px; padding: 1px 6px; border-radius: 4px; font-weight: 500; }
  .tag.肿瘤 { background: #FBEAF0; color: #993556; }
  .tag.心血管 { background: #FAEEDA; color: #854F0B; }
  .tag.内分泌 { background: #EAF3DE; color: #3B6D11; }
  .tag.消化 { background: #E6F1FB; color: #185FA5; }
  .tag.神经 { background: #EEEDFE; color: #534AB7; }
  .footer { margin-top: 20px; font-size: 12px; color: #999; text-align: center; }
</style></head><body>
<h1>评测模型对比报告</h1>
<p class="sub">SenseNova 6.7 Flash Lite vs DeepSeek V4 Flash (sensenova 免费通道) · ${comparisons.length} 题对比 · ${new Date().toISOString().slice(0, 10)}</p>

<div class="summary">
  <div class="card">
    <h3>评测覆盖率</h3>
    <div style="font-size:28px;font-weight:600">${dsCount}/${items.length}</div>
    <div style="font-size:13px;color:#666">跳过 ${dsSkipped} 条</div>
  </div>
  <div class="card">
    <h3>忠实度 (SenseNova)</h3>
    <div class="val sn">${(() => { const m = comparisons.filter(c=>c.sn.faith!=null); return m.length ? (m.reduce((s,c)=>s+c.sn.faith,0)/m.length).toFixed(3) : 'N/A'; })()}</div>
  </div>
  <div class="card">
    <h3>忠实度 (DeepSeek)</h3>
    <div class="val ds">${avg(dsTotal.faith, dsCount)}</div>
    <div class="delta ${Number(avg(dsTotal.faith, dsCount)) < (comparisons.filter(c=>c.sn.faith!=null).reduce((s,c)=>s+c.sn.faith,0)/Math.max(1,comparisons.filter(c=>c.sn.faith!=null).length)) ? 'down' : 'up'}">
      差值: ${(Number(avg(dsTotal.faith, dsCount)) - (comparisons.filter(c=>c.sn.faith!=null).reduce((s,c)=>s+c.sn.faith,0)/Math.max(1,comparisons.filter(c=>c.sn.faith!=null).length))).toFixed(3)}
    </div>
  </div>
</div>

<h2>四维评分均值对比（交集 ${comparisons.filter(c=>c.sn.faith!=null).length} 题）</h2>
<table><thead><tr><th>维度</th><th>SenseNova</th><th>DeepSeek</th><th>差值</th></tr></thead>
<tbody>
${['faith','rel','clin','saf'].map(dim => {
  const labels = {faith:'忠实度',rel:'相关性',clin:'临床正确性',saf:'安全性'};
  const matched = comparisons.filter(c => c.sn.faith != null);
  const m = matched.length;
  const snAvg = matched.reduce((s,c) => s + (c.sn[dim]||0), 0) / m;
  const dsAvg = matched.reduce((s,c) => s + (c.ds[dim]||0), 0) / m;
  const diff = dsAvg - snAvg;
  return `<tr><td><strong>${labels[dim]}</strong></td><td>${snAvg.toFixed(3)}</td><td>${dsAvg.toFixed(3)}</td><td class="${diff < 0 ? 'down' : 'up'}">${diff >= 0 ? '+' : ''}${diff.toFixed(3)}</td></tr>`;
}).join('\n')}
</tbody></table>

<h2 style="margin-top:24px">逐题对比（忠实度降幅 Top 20）</h2>
<table><thead><tr><th>ID</th><th>科室</th><th>问题</th><th>SenseNova</th><th>DeepSeek</th><th>差值</th><th>DeepSeek 理由</th></tr></thead>
<tbody>
${comparisons.filter(c=>c.diff).sort((a,b)=>(a.diff?.faith||0)-(b.diff?.faith||0)).slice(0,20).map(c => {
  const w = (v) => Math.round((v||0)*100);
  return `<tr>
    <td>${c.id}</td><td><span class="tag ${c.department}">${c.department}</span></td>
    <td>${esc(c.question)}</td>
    <td><div class="bar-cell"><span class="bar sn" style="width:${w(c.sn.faith)}px"></span>${c.sn.faith.toFixed(2)}</div></td>
    <td><div class="bar-cell"><span class="bar ds" style="width:${w(c.ds.faith)}px"></span>${c.ds.faith.toFixed(2)}</div></td>
    <td class="${(c.diff?.faith||0) < 0 ? 'down' : 'up'}">${(c.diff?.faith||0) >= 0 ? '+' : ''}${(c.diff?.faith||0).toFixed(2)}</td>
    <td style="font-size:12px;color:#666;max-width:300px">${esc((c.dsReasons||'').slice(0,120))}</td>
  </tr>`;
}).join('\n')}
</tbody></table>

<div class="footer">由 llm-judge 自动生成 · LLM_JUDGE_MODEL=${process.env.LLM_JUDGE_MODEL || 'sensenova-6.7-flash-lite'} · ${new Date().toISOString()}</div>
</body></html>`;

writeFileSync(REPORT_PATH, html, "utf-8");
console.log(`\nHTML 报告已写入: ${REPORT_PATH}`);
console.log("打开该文件查看可视化对比。");
