/**
 * 对比报告生成器：Sensenova vs Agnes
 *
 * 读取 baseline.json（sensenova 评分）和 judge-serial-report.json（Agnes 评分），
 * 生成 HTML 对比报告。
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const AGNES_PATH = join(ROOT, "tests", "reports", "judge-serial-report.json");
const BASELINE_PATH = join(ROOT, "tests", "reports", "baseline.json");
const REPORT_PATH = join(ROOT, "tests", "reports", "comparison-sn-vs-agnes.html");

const agnes = JSON.parse(readFileSync(AGNES_PATH, "utf-8"));
const agnesMap = {};
for (const item of agnes.items) agnesMap[item.id] = item;

// 读取 baseline 中的 llmJudge 评分
const baselineDetail = {};
if (existsSync(BASELINE_PATH)) {
  const bl = JSON.parse(readFileSync(BASELINE_PATH, "utf-8"));
  if (Array.isArray(bl.details)) {
    for (const d of bl.details) {
      if (d.id && d.llmJudge) baselineDetail[d.id] = d.llmJudge;
    }
  }
}

// 交集：65 题
const compared = agnes.items.map((a) => ({
  id: a.id, department: a.department, difficulty: a.difficulty,
  question: a.question,
  sn: baselineDetail[a.id] || null,
  ag: { faith: a.faithfulness, rel: a.answerRelevance, clin: a.clinicalCorrectness, saf: a.safety },
  reasons: a.reasons || "",
}));

const matched = compared.filter((c) => c.sn);
const stats = (arr, f) => arr.length ? (arr.reduce((s, c) => s + f(c), 0) / arr.length).toFixed(3) : "N/A";

function esc(s) { return String(s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }

const html = `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>SenseNova vs Agnes 评测对比</title>
<style>
body{font-family:-apple-system,system-ui,sans-serif;max-width:1200px;margin:0 auto;padding:20px;background:#f8f9fa;color:#222}
h1{font-size:22px;font-weight:600}
.sub{color:#666;font-size:13px;margin-bottom:20px}
.summary{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:24px}
.card{background:#fff;border-radius:10px;padding:16px 20px;flex:1;min-width:160px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
.card h3{margin:0 0 6px;font-size:13px;color:#666;font-weight:500}
.card .val{font-size:26px;font-weight:600}
.sn{color:#378ADD}.ag{color:#D4537E}
.delta{font-size:13px;margin-top:4px}
.up{color:#639922}.down{color:#D85A30}
table{width:100%;border-collapse:collapse;background:#fff;border-radius:10px;overflow:hidden;box-shadow:0 1px 3px rgba(0,0,0,.08);font-size:13px}
th{background:#f1f3f5;text-align:left;padding:10px 12px;font-weight:500;color:#444}
td{padding:8px 12px;border-top:1px solid #eee}
tr:hover td{background:#f8f9ff}
.tag{display:inline-block;font-size:11px;padding:1px 6px;border-radius:4px;font-weight:500}
.tag.肿瘤{background:#FBEAF0;color:#993556}.tag.心血管{background:#FAEEDA;color:#854F0B}
.tag.内分泌{background:#EAF3DE;color:#3B6D11}.tag.消化{background:#E6F1FB;color:#185FA5}
.tag.神经{background:#EEEDFE;color:#534AB7}.tag.儿科{background:#FBEAF0;color:#993556}
.tag.急诊{background:#FCEBEB;color:#A32D2D}.tag.外科综合{background:#F1EFE8;color:#5F5E5A}
.footer{margin-top:20px;font-size:12px;color:#999;text-align:center}
</style></head><body>
<h1>SenseNova 6.7 Flash Lite vs Agnes 2.0 Flash</h1>
<p class="sub">${compared.length} 题对比 · baseline.json vs judge-serial-report.json · ${new Date().toISOString().slice(0,10)}</p>

<div class="summary">
  <div class="card"><h3>评测总数</h3><div style="font-size:26px;font-weight:600">${agnes.total}</div><div style="font-size:13px;color:#666">跳过 ${agnes.skipped} 条 / 0 429</div></div>
  <div class="card"><h3>忠实度 (SenseNova)</h3><div class="val sn">${matched.length ? stats(matched, c => c.sn.faithfulness) : 'N/A'}</div></div>
  <div class="card"><h3>忠实度 (Agnes)</h3><div class="val ag">${agnes.avgFaithfulness}</div><div class="delta ${Number(agnes.avgFaithfulness) < (matched.length ? matched.reduce((s,c)=>s+(c.sn?.faithfulness||0),0)/matched.length : 0) ? 'down' : 'up'}">差值: ${(Number(agnes.avgFaithfulness) - (matched.length ? matched.reduce((s,c)=>s+(c.sn?.faithfulness||0),0)/matched.length : 0)).toFixed(3)}</div></div>
</div>

<h2>四维均值（交集 ${matched.length} 题）</h2>
<table><thead><tr><th>维度</th><th>SenseNova</th><th>Agnes</th><th>差值</th><th>说明</th></tr></thead>
<tbody>
${['faithfulness','answerRelevance','clinicalCorrectness','safety'].map(dim => {
  const labels = {faithfulness:'忠实度',answerRelevance:'相关性',clinicalCorrectness:'临床正确性',safety:'安全性'};
  const m = matched.length;
  if (!m) return '';
  const snAvg = matched.reduce((s,c) => s + ((c.sn||{})[dim]||0), 0) / m;
  const agAvg = matched.reduce((s,c) => s + ((c.ag||{})[{faithfulness:'faith',answerRelevance:'rel',clinicalCorrectness:'clin',safety:'saf'}[dim]]||0), 0) / m;
  const diff = agAvg - snAvg;
  const notes = {faithfulness: diff < -0.02 ? 'Agnes 更严格' : diff > 0.02 ? 'SenseNova 更严格' : '相近', answerRelevance: '', clinicalCorrectness: '', safety: ''};
  return `<tr><td><strong>${labels[dim]}</strong></td><td>${snAvg.toFixed(3)}</td><td>${agAvg.toFixed(3)}</td><td class="${diff < 0 ? 'down' : 'up'}">${diff >= 0 ? '+' : ''}${diff.toFixed(3)}</td><td style="color:#666;font-size:12px">${notes[dim] || ''}</td></tr>`;
}).join('\n')}
</tbody></table>

<h2 style="margin-top:24px">逐题忠实度对比（降序排列）</h2>
<table><thead><tr><th>ID</th><th>科室</th><th>问题</th><th>SN</th><th>Agnes</th><th>Δ</th><th>Agnes 理由</th></tr></thead>
<tbody>
${compared.filter(c=>c.sn).sort((a,b)=>((b.ag?.faith||0)-(b.sn?.faithfulness||0)) - ((a.ag?.faith||0)-(a.sn?.faithfulness||0))).map(c => {
  return `<tr>
    <td>${c.id}</td><td><span class="tag ${c.department}">${c.department}</span></td>
    <td>${esc(c.question)}</td>
    <td>${(c.sn?.faithfulness||0).toFixed(2)}</td>
    <td><strong>${(c.ag?.faith||0).toFixed(2)}</strong></td>
    <td class="${((c.ag?.faith||0) - (c.sn?.faithfulness||0)) < -0.1 ? 'down' : 'up'}">${((c.ag?.faith||0) - (c.sn?.faithfulness||0)) >= 0 ? '+' : ''}${((c.ag?.faith||0) - (c.sn?.faithfulness||0)).toFixed(2)}</td>
    <td style="font-size:12px;color:#666;max-width:250px">${esc((c.reasons||'').slice(0,100))}</td>
  </tr>`;
}).join('\n')}
</tbody></table>

<div class="footer">由 compare-judge-models.mjs 自动生成 · ${new Date().toISOString()}</div>
</body></html>`;

writeFileSync(REPORT_PATH, html, "utf-8");
console.log(`报告已写入: ${REPORT_PATH}`);
