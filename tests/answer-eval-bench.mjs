// answer-eval-bench.mjs
// 医疗 Agentic RAG 系统 · 答案级评测基准（T1）
//
// 目的：在既有「路由级」评测（eval-bench.mjs）之外，补齐此前缺失的「答案级」质量度量：
//   1) 引用召回率 (Citation Recall)     —— 系统应引用的指南是否进入路由 top3；
//   2) 证据可定位率 (Evidence Locatability) —— 关键证据短语是否真存在于源文档文本；
//   3) 证据等级标注率 (GRADE Label Rate)—— 源文档是否携带「推荐意见/证据等级」等循证标记；
//   4) 幻觉率 (Hallucination Rate)     —— 预留 LLM 钩子（免费模型优先），无 API Key 时自动跳过并标注。
//
// 设计原则：
//   - 纯 node 运行，无需 jiti / 不强制 API Key：三项离线指标必有量化值；
//   - 幻觉检测仅在 SENSENOVA_API_KEY 存在时调用 sensenova 免费通道，否则 skipped；
//   - 证据短语一律经 normalize 后再做子串匹配，容忍中英文标点/全半角差异。
//
// 输出：tests/answer-eval-report.json + tests/answer-eval-report.html

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { routeGuides, loadIndex, normalize } from "../.pi/extensions/lib/guide-router.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const index = loadIndex(REPO_ROOT);
const TXT_DIR = join(REPO_ROOT, "medical-raw-txt");

// ---------- 10 条真实问答样本（证据短语均取自对应指南原文） ----------
const SAMPLES = [
  {
    q: "原发性肝癌一线系统抗肿瘤治疗推荐哪些药物",
    gtSources: ["原发性肝癌诊疗指南（2026版）"],
    evidencePhrases: ["一线系统抗肿瘤治疗", "仑伐替尼", "索拉非尼", "经导管动脉化疗栓塞"],
    expectGradeLabel: true,
    answerDraft:
      "原发性肝癌一线系统抗肿瘤治疗可优先选择阿替利珠单抗联合贝伐珠单抗，或仑伐替尼联合派安普利单抗；多纳非尼、仑伐替尼、索拉非尼等也可用于一线。",
  },
  {
    q: "儿童肺炎支原体肺炎耐药了怎么处理",
    gtSources: ["儿童肺炎支原体肺炎诊疗指南（2025年版）"],
    evidencePhrases: ["大环内酯类抗菌", "MP 耐药", "耐药性检测"],
    expectGradeLabel: true,
  },
  {
    q: "新型抗肿瘤药物临床应用如何合理选择",
    gtSources: ["新型抗肿瘤药物临床应用指导原则（2025年版）"],
    evidencePhrases: ["合理选择适宜的抗肿瘤药物", "新型抗肿瘤药物临床应用指导原则"],
    expectGradeLabel: true,
  },
  {
    q: "前列腺癌内分泌治疗的基本原则",
    gtSources: ["前列腺癌诊疗指南（2022年版）"],
    evidencePhrases: ["前列腺癌", "内分泌治疗"],
    expectGradeLabel: true,
  },
  {
    q: "乳腺癌化疗方案一般怎么推荐",
    gtSources: ["中国抗癌协会乳腺癌诊治指南与规范（2025年版）"],
    evidencePhrases: ["乳腺癌", "化疗"],
    expectGradeLabel: true,
  },
  {
    q: "2024版肺癌靶向治疗的适用指征",
    gtSources: ["中华医学会肺癌临床诊疗指南（2024版）"],
    evidencePhrases: ["肺癌", "靶向治疗"],
    expectGradeLabel: true,
  },
  {
    q: "慢性髓性白血病一线用药是什么",
    gtSources: ["慢性髓性白血病诊疗指南（2022年版）"],
    evidencePhrases: ["慢性髓性白血病", "酪氨酸激酶抑制剂"],
    expectGradeLabel: true,
  },
  {
    q: "高血压降压治疗的目标与原则",
    gtSources: ["中国高血压防治指南(2024年修订版)"],
    evidencePhrases: ["高血压", "降压治疗"],
    expectGradeLabel: true,
  },
  {
    q: "2型糖尿病综合管理的要点",
    gtSources: ["中国糖尿病防治指南（2024版）"],
    evidencePhrases: ["糖尿病", "生活方式干预"],
    expectGradeLabel: true,
  },
  {
    q: "淋巴瘤化疗的基本原则有哪些",
    gtSources: ["淋巴瘤诊疗指南（2022年版）"],
    evidencePhrases: ["淋巴瘤", "化疗"],
    expectGradeLabel: true,
  },
];

// 证据等级 / 循证标记词（任一命中即视为该指南携带 GRADE 结构）
const GRADE_TOKENS = [
  "推荐意见", "证据等级", "强推荐", "弱推荐",
  "Ⅰ级", "Ⅱ级", "Ⅲ级", "证据质量", "推荐强度",
  "高质量", "中等质量", "低质量",
];

// 读取指南原文（按索引 id 定位 medical-raw-txt/<id>.txt）
function readGuideText(title) {
  const info = index.guideMap[title];
  if (!info) return { text: null, missing: "not_in_index" };
  const p = join(TXT_DIR, `${info.id}.txt`);
  if (!existsSync(p)) return { text: null, missing: "txt_not_found" };
  try {
    return { text: readFileSync(p, "utf-8"), missing: null };
  } catch {
    return { text: null, missing: "read_error" };
  }
}

// ---------- 幻觉检测钩子（免费模型优先；无 Key 自动跳过） ----------
const RUN_LLM = !!process.env.SENSENOVA_API_KEY;
async function checkHallucination(sample) {
  if (!RUN_LLM) return { skipped: true, reason: "no_api_key" };
  if (!sample.answerDraft) return { skipped: true, reason: "no_draft" };
  const key = process.env.SENSENOVA_API_KEY;
  const endpoint = "https://token.sensenova.cn/v1/chat/completions";
  const prompt =
    `你是医疗事实核查员。给定用户问题、应引用的指南、模型应答草稿，` +
    `判断应答是否存在无指南支撑的断言（幻觉/事实错误）。仅返回 JSON：{"hasHallucination":boolean,"reasons":[string]}。` +
    `问题：${sample.q}\n应引用指南：${sample.gtSources.join("、")}\n应答草稿：${sample.answerDraft}`;
  try {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: "sensenova-6.7-flash-lite",
        messages: [{ role: "user", content: prompt }],
        temperature: 0,
      }),
    });
    const j = await r.json();
    const txt = j?.choices?.[0]?.message?.content || "";
    const m = txt.match(/\{[\s\S]*\}/);
    const obj = m ? JSON.parse(m[0]) : { hasHallucination: null };
    return { skipped: false, ...obj };
  } catch (e) {
    return { skipped: true, reason: "call_failed:" + e.message };
  }
}

// ---------- 运行 + 聚合 ----------
function pct(a, b) {
  return b === 0 ? 0 : +((a / b) * 100).toFixed(1);
}

let citHit = 0, citTot = 0;
let evHit = 0, evTot = 0;
let gradeHit = 0, gradeTot = 0;
let hallYes = 0, hallChecked = 0;

const details = [];
for (const s of SAMPLES) {
  const route = routeGuides(s.q, { index, useCache: false });
  const top3 = route.top.slice(0, 3).map((g) => g.title);
  const gtHit = s.gtSources.filter((g) => top3.includes(g)).length;
  citHit += gtHit;
  citTot += s.gtSources.length;

  let evLocalHit = 0, evLocalTot = 0;
  let gradeLocal = false;
  const missingSources = [];
  for (const gt of s.gtSources) {
    const { text, missing } = readGuideText(gt);
    if (text == null) {
      evLocalTot += s.evidencePhrases.length;
      if (missing) missingSources.push(`${gt}:${missing}`);
      continue;
    }
    const ntxt = normalize(text);
    for (const ph of s.evidencePhrases) {
      evLocalTot++;
      if (ntxt.includes(normalize(ph))) evLocalHit++;
    }
    if (!gradeLocal && GRADE_TOKENS.some((t) => text.includes(t))) {
      gradeLocal = true;
    }
  }
  evHit += evLocalHit;
  evTot += evLocalTot;
  if (s.expectGradeLabel !== false) gradeTot++;
  if (gradeLocal) gradeHit++;

  const hall = await checkHallucination(s);
  if (!hall.skipped && typeof hall.hasHallucination === "boolean") {
    hallChecked++;
    if (hall.hasHallucination) hallYes++;
  }

  details.push({
    q: s.q,
    gtSources: s.gtSources,
    top3,
    citation: { hit: gtHit, tot: s.gtSources.length },
    evidence: { hit: evLocalHit, tot: evLocalTot, missing: missingSources },
    gradeFound: gradeLocal,
    expectGrade: s.expectGradeLabel !== false,
    hallucination: hall,
  });
}

const metrics = {
  generatedAt: new Date().toISOString(),
  knowledgeBase: {
    guides: Object.keys(index.guideMap).length,
    keywords: index.totalKeywords,
  },
  kpi: {
    citationRecall: pct(citHit, citTot),
    evidenceLocatability: pct(evHit, evTot),
    gradeLabelRate: pct(gradeHit, gradeTot),
    hallucinationRate: RUN_LLM
      ? hallChecked === 0 ? "n/a" : pct(hallYes, hallChecked)
      : "skipped (no SENSENOVA_API_KEY)",
  },
  raw: { citHit, citTot, evHit, evTot, gradeHit, gradeTot, hallYes, hallChecked },
};

const report = { metrics, details };
writeFileSync(
  join(REPO_ROOT, "tests", "answer-eval-report.json"),
  JSON.stringify(report, null, 2),
  "utf-8",
);

// ---------- 控制台摘要 ----------
const line = "─".repeat(64);
console.log(line);
console.log("医疗 Agentic RAG · 答案级评测基线（T1）");
console.log(line);
console.log(`知识库: ${metrics.knowledgeBase.guides} 指南 / ${metrics.knowledgeBase.keywords} 关键词`);
console.log(line);
console.log(`引用召回率 (Citation Recall)      : ${metrics.kpi.citationRecall}%  (${citHit}/${citTot})`);
console.log(`证据可定位率 (Evidence Locat.)    : ${metrics.kpi.evidenceLocatability}%  (${evHit}/${evTot})`);
console.log(`证据等级标注率 (GRADE Label)    : ${metrics.kpi.gradeLabelRate}%  (${gradeHit}/${gradeTot})`);
console.log(`幻觉率 (Hallucination Rate)      : ${metrics.kpi.hallucinationRate}${RUN_LLM ? `  (${hallYes}/${hallChecked})` : ""}`);
console.log(line);
for (const d of details) {
  const ok = d.citation.hit === d.citation.tot;
  const ev = d.evidence.tot ? pct(d.evidence.hit, d.evidence.tot) : "—";
  console.log(
    `  ${ok ? "✓" : "✗"} 引${d.citation.hit}/${d.citation.tot} 证${ev}% 级${d.gradeFound ? "✓" : "✗"}  ${d.q}`,
  );
  if (!ok) console.log(`      期望: ${d.gtSources.join(" | ")}`);
  if (d.evidence.missing.length) console.log(`      源缺失: ${d.evidence.missing.join("；")}`);
}
console.log(line);
console.log(`报告已写出: tests/answer-eval-report.json`);

// ---------- 轻量液态玻璃 HTML 可视化 ----------
const k = metrics.kpi;
const card = (label, val, sub) =>
  `<div class="card"><div class="k">${label}</div><div class="v">${val}</div><div class="sub">${sub}</div><div class="bar"><i style="width:${typeof val === "number" ? val : 100}%"></i></div></div>`;
const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<title>医疗 Agentic RAG · 答案级评测</title>
<style>
:root{--bg:#0b0f17;--panel:rgba(255,255,255,.06);--bd:rgba(255,255,255,.12);--tx:#e6edf3;--mut:#8b949e;--bl:#58a6ff;--cy:#39d0d8;--pp:#bc8cff;--gn:#3fb950;--rd:#f85149;}
*{box-sizing:border-box}
body{font-family:-apple-system,Segoe UI,Roboto,'Microsoft YaHei',sans-serif;background:radial-gradient(1200px 600px at 70% -10%,rgba(88,166,255,.12),transparent),var(--bg);color:var(--tx);margin:0;padding:32px;}
h1{font-size:22px;margin:0 0 4px}
.s{color:var(--mut);font-size:13px;margin-bottom:24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:16px;margin-bottom:24px}
.card{background:var(--panel);backdrop-filter:blur(12px);border:1px solid var(--bd);border-radius:14px;padding:18px}
.k{color:var(--mut);font-size:12px}
.v{font-size:30px;font-weight:700;margin-top:6px}
.sub{color:var(--mut);font-size:11px;margin-top:4px}
.bar{height:8px;border-radius:4px;background:rgba(255,255,255,.08);margin-top:10px;overflow:hidden}
.bar>i{display:block;height:100%;background:linear-gradient(90deg,var(--cy),var(--bl))}
table{width:100%;border-collapse:collapse;font-size:13px;margin-top:8px;background:var(--panel);backdrop-filter:blur(12px);border:1px solid var(--bd);border-radius:12px;overflow:hidden}
th,td{text-align:left;padding:9px 12px;border-bottom:1px solid rgba(255,255,255,.06)}
th{color:var(--mut);font-weight:500;background:rgba(255,255,255,.03)}
.ok{color:var(--gn)}.bad{color:var(--rd)}.mut{color:var(--mut)}
</style></head><body>
<h1>医疗 Agentic RAG · 答案级评测基线</h1>
<div class="s">生成时间 ${metrics.generatedAt} · 知识库 ${metrics.knowledgeBase.guides} 指南 / ${metrics.knowledgeBase.keywords} 关键词 · 样本 ${SAMPLES.length} 条</div>
<div class="grid">
  ${card("引用召回率", k.citationRecall, `应引指南进入 top3 (${citHit}/${citTot})`)}
  ${card("证据可定位率", k.evidenceLocatability, `关键证据短语见于源文 (${evHit}/${evTot})`)}
  ${card("证据等级标注率", k.gradeLabelRate, `源文携带 GRADE 标记 (${gradeHit}/${gradeTot})`)}
  ${card("幻觉率", typeof k.hallucinationRate === "number" ? k.hallucinationRate : k.hallucinationRate, RUN_LLM ? `已检测 (${hallYes}/${hallChecked})` : "跳过(无API Key)")}
</div>
<table><thead><tr><th>引用</th><th>证据</th><th>等级</th><th>查询</th><th>应引指南(top3)</th></tr></thead><tbody>
${details
  .map((d) => {
    const cok = d.citation.hit === d.citation.tot;
    const ev = d.evidence.tot ? pct(d.evidence.hit, d.evidence.tot) + "%" : "—";
    return `<tr>
      <td class="${cok ? "ok" : "bad"}">${d.citation.hit}/${d.citation.tot}</td>
      <td class="${d.evidence.tot && d.evidence.hit === d.evidence.tot ? "ok" : "mut"}">${ev}</td>
      <td class="${d.gradeFound ? "ok" : "bad"}">${d.gradeFound ? "✓" : "✗"}</td>
      <td>${d.q}</td>
      <td class="mut">${d.gtSources.join(" | ")}</td>
    </tr>`;
  })
  .join("")}
</tbody></table>
</body></html>`;
writeFileSync(join(REPO_ROOT, "tests", "answer-eval-report.html"), html, "utf-8");
console.log(`可视化已写出: tests/answer-eval-report.html`);
console.log(line);
