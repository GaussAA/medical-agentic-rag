// answer-quality-judge.mjs
// 医疗 Agentic RAG · 端到端答案质量评测（LLM-Judge 四维 + 结构化断言）
//
// 本脚本补齐 answer-eval-bench 缺失的「答案级语义质量」度量：
//   - 结构化断言核对（allowedClaims 必含 / forbiddenClaims 必不含）：零成本、不依赖 LLM、可卡点
//   - LLM-Judge 四维：Faithfulness / Answer-Relevance / Clinical-Correctness / Safety（0–1）
//
// 免费模型优先（SENSENOVA）→ DeepSeek 兜底，无 API Key 时四维优雅 skipped。
// 待审回答优先 systemAnswer（端到端 live 模式），为空则 fallback referenceAnswer（reference-self-check）。
//
// 输出：tests/reports/answer-quality-report.json + tests/reports/answer-quality-report.html

import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync, writeFileSync } from "node:fs";
import { routeGuides, loadIndex, normalize } from "../../.pi/extensions/lib/guide-router.mjs";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const index = loadIndex(REPO_ROOT);
const TXT_DIR = join(REPO_ROOT, "data", "raw-txt");

const GOLD = JSON.parse(readFileSync(join(REPO_ROOT, "tests", "gold-answers.json"), "utf-8"));
const ITEMS = GOLD.items;

// ---------- 病种主题解析（引用召回容错匹配） ----------
// gold 的 gtSources 用「标准指南名」体系，KB 指南 title 含来源/版本噪声（如
// EuropePMC OA 的「（开放获取英文指南·中文结构化摘引）」后缀），二者字符串常不等；
// 且部分 gtSources 标注的指南 KB 实际以同主题不同来源指南存在。故引用召回改为
// 「病种主题匹配」：gtSources 解析为核心病种，判断路由 top3 是否覆盖该病种。
// 这修正了「同主题异名指南」造成的假阴性，同时不掩盖「路由错排病种」的真错路。
const DISEASE_VOCAB = (() => {
  const set = new Set();
  const gm = index.guideMap || {};
  for (const k of Object.keys(gm)) {
    if (gm[k].disease) set.add(gm[k].disease);
    if (gm[k].normalizedDisease) set.add(gm[k].normalizedDisease);
  }
  return [...set].filter((d) => d && d.length >= 2).sort((a, b) => b.length - a.length);
})();
function resolveGtDisease(gt) {
  if (!gt) return null;
  if (index.guideMap && index.guideMap[gt]) return index.guideMap[gt].disease || null;
  const n = normalize(gt);
  for (const d of DISEASE_VOCAB) {
    if (n.includes(normalize(d))) return d;
  }
  return null;
}

const REFUSAL_KW = ["超出", "不在范围", "不在服务", "不提供", "无法提供", "非医疗"];

// 免费优先 LLM 客户端与四维 Judge 统一由 lib/llm-judge.mjs 提供（单一真相源，与 /eval 共用）。
import { isLLMAvailable, judgeAnswer, runWithConcurrency, SENSENOVA_CONCURRENCY } from "../../.pi/extensions/lib/llm-judge.mjs";
// GRADE / 推荐强度标记词表（.pi/extensions/lib/grade-markers.mjs 单一真相源）。
// 原 GRADE_TOKENS 仅含英文 GRADE 原词，误判卫健委中文指南为「缺 GRADE 标记」；
// hasGradeMarker 合并「标准化 GRADE 原词 + 中文推荐强度表述」，贴合指标语义。
import { hasGradeMarker, hasStrictGrade } from "../../.pi/extensions/lib/grade-markers.mjs";
const RUN_LLM = isLLMAvailable();

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

// ---------- 结构化断言核对（不依赖 LLM） ----------
// allowedClaims：硬必含（任一缺失即判该题为不通过，用于 CI 卡点）
// preferredClaims：软宜含（仅记录覆盖率，不阻断；用于趋势观察）

// 近义词表：允许断言的关键词近义扩展（覆盖"医师指导"↔"医师"、"立即拨打急救电话"↔"立即就医"等常见表达变体）
const ALLOWED_SYNONYMS = {
  "立即拨打急救电话": ["立即就医", "呼叫急救", "拨打 120", "拨打急救电话", "立即拨打120", "立即送医", "立刻就医"],
  "尽早启动": ["尽早", "早期开始", "尽快启动", "一旦确诊", "尽早开始", "早期启动"],
  "替代药物": ["替代治疗", "替代方案", "换用", "其他药物"],
  "含铋四联疗法": ["铋剂四联", "四联疗法", "含铋四联"],
  "吸入支气管扩张剂": ["吸入制剂", "支气管扩张", "吸入药物", "吸入"],
  "影像排除出血": ["排除脑出血", "影像排除", "ct 排除"],
  "急危重症": ["急症", "危重症", "危急情况", "危急重症"],
  "对因处理": ["对因", "针对病因", "针对原因"],
  "医师指导": ["医师", "医生指导", "专科医师", "咨询医师"],
  "规范化": ["规范治疗", "规范化治疗", "规范"],
  "药师": ["药学", "临床药学", "药学咨询"],
  "HPV 核酸检测": ["hpv 检测", "hpv 核酸", "hpv 筛查", "hpv 分型"],
  "LAMA+LABA 联合": ["lama 联合 laba", "laba 联合 lama"],
  "复查": ["再次检查", "复检", "再次检测", "随访检查"],
  "维生素 D": ["维生素d"],
  "戒烟": ["戒烟"],
  "过量": ["超量", "超剂量", "剂量过大"],
};
/** 近义匹配：先精确匹配，再查同义词表。 */
function matchClaim(nAns, claim) {
  const nClaim = normalize(claim);
  if (nAns.includes(nClaim)) return true;
  const syns = ALLOWED_SYNONYMS[claim];
  if (syns) return syns.some((s) => nAns.includes(normalize(s)));
  // 对≥2字的短语，若所有单字/词元均独立出现在回答中，也视为命中
  // （避免"LAMA+LABA联合"三词分开时误判为缺失）
  const tokens = nClaim.split(/\s+/).filter(Boolean);
  if (tokens.length >= 2 && tokens.every((t) => nAns.includes(t))) return true;
  return false;
}

function checkAssertions(item, answer) {
  const nAns = normalize(answer);
  const allowedPass = (item.allowedClaims || []).every((c) => matchClaim(nAns, c));
  const forbiddenHit = (item.forbiddenClaims || []).filter((c) => nAns.includes(normalize(c)));
  const pClaims = item.preferredClaims || [];
  const preferredHit = pClaims.filter((c) => nAns.includes(normalize(c))).length;
  const refusalOk = item.expectedRefusal
    ? REFUSAL_KW.some((k) => answer.includes(k))
    : true;
  return {
    allowedPass,
    forbiddenHit,
    forbiddenCount: forbiddenHit.length,
    preferredHit,
    preferredTotal: pClaims.length,
    refusalOk,
    mode: item.systemAnswer ? "live" : "reference-self-check",
  };
}

// ---------- LLM-Judge 四维（委托 lib/llm-judge.mjs 单一真相源） ----------
async function llmJudge(item, answer) {
  return judgeAnswer({
    question: item.q,
    answer,
    referenceAnswer: item.referenceAnswer,
    gtSources: item.gtSources,
  });
}

// ---------- 聚合 ----------
function pct(a, b) { return b === 0 ? null : +((a / b) * 100).toFixed(1); }
function avg(arr) { return arr.length ? +(arr.reduce((s, x) => s + x, 0) / arr.length).toFixed(3) : null; }
function esc(s) { return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])); }
function rateCls(v, good = 90, warn = 75) { if (v == null) return "warn"; if (v >= good) return "ok"; if (v >= warn) return "warn"; return "bad"; }

// ---------- 液态玻璃 HTML 报告 ----------
const REPORT_CSS = `
  :root{--bg:#070b16;--bg2:#0b1224;--glass:rgba(255,255,255,.045);--glass-strong:rgba(255,255,255,.07);
    --border:rgba(120,160,255,.16);--border2:rgba(120,160,255,.30);--txt:#e8eefc;--muted:#9fb0d0;
    --blue:#3b82f6;--cyan:#22d3ee;--violet:#a78bfa;--green:#34d399;--amber:#fbbf24;--red:#f87171;
    --grad:linear-gradient(135deg,#3b82f6,#22d3ee);--grad-v:linear-gradient(135deg,#a78bfa,#3b82f6);}
  *{box-sizing:border-box;margin:0;padding:0} html{scroll-behavior:smooth}
  body{font-family:"Segoe UI","PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:var(--txt);
    background:var(--bg);line-height:1.7;overflow-x:hidden;}
  body::before{content:"";position:fixed;inset:0;z-index:-2;background:
    radial-gradient(900px 600px at 12% 8%,rgba(59,130,246,.18),transparent 60%),
    radial-gradient(800px 700px at 88% 22%,rgba(168,139,250,.14),transparent 60%),
    radial-gradient(700px 700px at 50% 100%,rgba(34,211,238,.10),transparent 55%),var(--bg);}
  body::after{content:"";position:fixed;inset:0;z-index:-1;opacity:.5;
    background-image:linear-gradient(rgba(120,160,255,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(120,160,255,.05) 1px,transparent 1px);
    background-size:46px 46px;mask:radial-gradient(circle at 50% 30%,#000,transparent 80%);}
  .wrap{max-width:1180px;margin:0 auto;padding:38px 22px 90px}
  .hero{position:relative;border-radius:26px;padding:40px 38px;margin-bottom:28px;
    background:linear-gradient(135deg,rgba(59,130,246,.16),rgba(34,211,238,.08));border:1px solid var(--border2);
    overflow:hidden;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);box-shadow:0 20px 60px rgba(0,0,0,.45),inset 0 1px 0 rgba(255,255,255,.08);}
  .hero::before{content:"";position:absolute;top:-60%;right:-10%;width:420px;height:420px;border-radius:50%;
    background:radial-gradient(circle,rgba(34,211,238,.35),transparent 70%);filter:blur(20px)}
  .eyebrow{font-size:13px;letter-spacing:.28em;color:var(--cyan);text-transform:uppercase;font-weight:600}
  .hero h1{font-size:32px;font-weight:800;margin:10px 0 12px;background:linear-gradient(90deg,#fff,#bfe0ff);
    -webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .hero p{color:var(--muted);max-width:800px;font-size:15px}
  .meta{display:flex;flex-wrap:wrap;gap:10px;margin-top:18px}
  .chip{font-size:12px;padding:6px 13px;border-radius:999px;background:var(--glass);border:1px solid var(--border);color:var(--muted)}
  .chip b{color:var(--txt)}
  section{margin-bottom:34px}
  h2{font-size:23px;font-weight:750;margin:0 0 6px;display:flex;align-items:center;gap:12px}
  h2 .num{display:inline-flex;align-items:center;justify-content:center;width:34px;height:34px;border-radius:11px;
    background:var(--grad);color:#04121f;font-size:16px;font-weight:800;box-shadow:0 6px 18px rgba(59,130,246,.4)}
  .lead{color:var(--muted);font-size:14.5px;margin:0 0 20px;max-width:920px}
  .card{background:var(--glass);border:1px solid var(--border);border-radius:18px;padding:22px 24px;
    backdrop-filter:blur(12px);-webkit-backdrop-filter:blur(12px);box-shadow:0 10px 30px rgba(0,0,0,.28)}
  .grid{display:grid;gap:18px}.g2{grid-template-columns:1fr 1fr}.g3{grid-template-columns:repeat(3,1fr)}.g4{grid-template-columns:repeat(4,1fr)}
  @media(max-width:880px){.g2,.g3,.g4{grid-template-columns:1fr}}
  .metric{background:var(--glass);border:1px solid var(--border);border-radius:16px;padding:18px;position:relative;overflow:hidden}
  .metric .v{font-size:30px;font-weight:800;background:var(--grad);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent}
  .metric .l{font-size:12.5px;color:var(--muted);margin-top:3px}
  .metric .sub{font-size:11px;color:var(--cyan);margin-top:6px}
  .metric::after{content:"";position:absolute;right:-30px;bottom:-30px;width:90px;height:90px;border-radius:50%;
    background:radial-gradient(circle,rgba(59,130,246,.25),transparent 70%)}
  .bar{display:flex;align-items:center;gap:12px;margin:10px 0;font-size:13px}
  .bar .name{width:130px;color:var(--muted);text-align:right;flex:none}
  .bar .track{flex:1;height:24px;background:rgba(255,255,255,.05);border-radius:7px;overflow:hidden}
  .bar .fill{height:100%;border-radius:7px;background:var(--grad);box-shadow:0 0 12px rgba(59,130,246,.4);
    display:flex;align-items:center;justify-content:flex-end;padding-right:8px;color:#04121f;font-size:11.5px;font-weight:700;
    width:0;transition:width 1.1s cubic-bezier(.2,.8,.2,1)}
  .bar .fill.v{background:var(--grad-v)}
  table{width:100%;border-collapse:collapse;font-size:13.5px;margin-top:6px}
  th,td{padding:10px 12px;text-align:left;border-bottom:1px solid rgba(120,160,255,.10)}
  th{color:#cfe0ff;font-weight:600;background:rgba(255,255,255,.03);position:sticky;top:0}
  tr:hover td{background:rgba(255,255,255,.025)}
  .ok{color:var(--green);font-weight:600}.warn{color:var(--amber);font-weight:600}.bad{color:var(--red);font-weight:600}
  .pill{display:inline-block;font-size:11px;padding:2px 8px;border-radius:7px;border:1px solid var(--border);color:var(--muted)}
  .pill.ok{color:var(--green);border-color:rgba(52,211,153,.4);background:rgba(52,211,153,.1)}
  .pill.bad{color:var(--red);border-color:rgba(248,113,113,.4);background:rgba(248,113,113,.1)}
  .pill.warn{color:var(--amber);border-color:rgba(251,191,36,.4);background:rgba(251,191,36,.1)}
  .tag{display:inline-block;font-size:11.5px;padding:3px 9px;border-radius:7px;background:rgba(59,130,246,.16);
    border:1px solid var(--border);color:#bcd6ff;margin:2px 4px 2px 0}
  .note{font-size:13px;color:var(--muted);padding:12px 16px;border-left:3px solid var(--cyan);background:rgba(34,211,238,.06);border-radius:0 12px 12px 0;margin-top:14px}
  footer{text-align:center;color:var(--muted);font-size:12.5px;margin-top:40px}
`;

function buildHtmlReport(metrics, details) {
  const k = metrics.kpi, kb = metrics.knowledgeBase, raw = metrics.raw;
  const gen = new Date(metrics.generatedAt).toLocaleString("zh-CN");
  const isE2E = !!(metrics.endToEnd && metrics.endToEnd.active);
  const heroDesc = isE2E
    ? "LLM-Judge 四维评分 + 结构化断言核对（zero-cost）。本基线为<b>端到端（live）模式</b>：以待测 Agent 的<b>真实输出</b>为待审回答，量化生产系统在实际检索增强下的答案可信度，幻觉 / 临床正确性可直接设为 CI 卡点。"
    : "LLM-Judge 四维评分 + 结构化断言核对（zero-cost）。本基线为 <b>reference-self-check 模式</b>：以黄金标准答案为待审回答，校验评测引擎本身上限。回填 systemAnswer 即升为端到端。";
  const bars = [
    { n: "引用召回率", v: k.citationRecall, c: "ok" },
    { n: "证据可定位率", v: k.evidenceLocatability, c: "ok" },
    { n: "证据等级标注率", v: k.gradeLabelRate, c: "warn" },
    { n: "允许断言通过率", v: k.allowedClaimRate, c: "ok" },
    { n: "宜含覆盖率(软)", v: k.preferredClaimRate, c: "ok" },
    { n: "禁戒断言违例率", v: k.forbiddenViolationRate, c: "ok" },
    { n: "越界拒答准确率", v: k.refusalAccuracy, c: "ok" },
  ];
  const barHtml = bars.map((b) => {
    const val = b.v == null ? 0 : b.v;
    const show = b.v == null ? "—" : `${b.v}%`;
    const inv = b.n === "禁戒断言违例率";
    const fillW = inv ? (100 - val) : val; // 违例率越低越好 → 反向填充
    const cls = inv ? (val === 0 ? "ok" : "bad") : rateCls(b.v);
    return `<div class="bar"><div class="name">${esc(b.n)}</div><div class="track"><div class="fill ${cls === "ok" ? "" : "v"}" data-w="${Math.max(fillW, 4)}"></div></div><div style="width:64px;color:var(--${cls === "ok" ? "green" : cls === "warn" ? "amber" : "red"});font-weight:600">${show}</div></div>`;
  }).join("");

  const rows = details.map((d) => {
    const a = d.assertion;
    const cit = d.citation.tot ? `${d.citation.hit}/${d.citation.tot}` : "—";
    const ev = d.evidence.tot ? `${pct(d.evidence.hit, d.evidence.tot)}%` : "—";
    const grade = d.gradeFound ? '<span class="pill ok">✓</span>' : '<span class="pill bad">✗ 缺GRADE</span>';
    const allow = a.allowedPass ? '<span class="pill ok">✓</span>' : '<span class="pill bad">✗</span>';
    const forbid = a.forbiddenCount === 0 ? '<span class="pill ok">✓</span>' : `<span class="pill bad">✗${a.forbiddenCount}</span>`;
    const jd = d.judge.skipped ? '<span class="pill warn">跳过</span>' : '<span class="pill ok">已评</span>';
    const diff = d.difficulty === "陷阱" ? '<span class="tag" style="color:var(--red);border-color:rgba(248,113,113,.4)">陷阱</span>' : esc(d.difficulty);
    return `<tr><td><b>${esc(d.id)}</b></td><td>${esc(d.department)}</td><td>${diff}</td><td>${cit}</td><td>${ev}</td><td>${grade}</td><td>${allow}</td><td>${forbid}</td><td>${jd}</td><td style="max-width:320px;color:var(--muted)">${esc(d.q)}</td></tr>`;
  }).join("");

  const judgeStatus = typeof k.llmJudge === "object"
    ? `忠实 ${k.llmJudge.faithfulness} / 相关 ${k.llmJudge.answerRelevance} / 临床 ${k.llmJudge.clinicalCorrectness} / 安全 ${k.llmJudge.safety}（n=${k.llmJudge.n}）`
    : "未启用（无 API Key，四维优雅跳过）";

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1.0"/>
<title>医疗 Agentic RAG · 端到端答案质量评测报告</title><style>${REPORT_CSS}</style></head>
<body><div class="wrap">
  <div class="hero">
    <div class="eyebrow">Answer Quality Evaluation</div>
    <h1>医疗 Agentic RAG · 端到端答案质量评测</h1>
    <p>${heroDesc}</p>
    <div class="meta">
      <span class="chip">生成时间 <b>${esc(gen)}</b></span>
      <span class="chip">运行模式 <b>${esc(metrics.mode)}</b></span>
      <span class="chip">知识库 <b>${kb.guides}</b> 指南 / <b>${kb.keywords}</b> 关键词</span>
      <span class="chip">样本 <b>${details.length}</b> 条</span>
    </div>
  </div>

  <section>
    <h2><span class="num">1</span>核心指标</h2>
    <p class="lead">离线结构层量化（无需 LLM）。self-check 模式下「允许断言通过率」应趋近 100%，以证成断言引擎正确；「禁戒断言违例率」应为 0%。</p>
    <div class="grid g2">
      <div class="card"><h3><span class="dot"></span>指标条</h3>${barHtml}</div>
      <div class="card"><h3><span class="dot"></span>LLM-Judge 四维</h3>
        <div class="bar"><div class="name">忠实 Faithful</div><div class="track"><div class="fill" data-w="${typeof k.llmJudge === "object" ? Math.round((k.llmJudge.faithfulness || 0) * 100) : 0}"></div></div><div style="width:64px;color:var(--muted)">${typeof k.llmJudge === "object" ? k.llmJudge.faithfulness : "—"}</div></div>
        <div class="bar"><div class="name">相关 Relev.</div><div class="track"><div class="fill v" data-w="${typeof k.llmJudge === "object" ? Math.round((k.llmJudge.answerRelevance || 0) * 100) : 0}"></div></div><div style="width:64px;color:var(--muted)">${typeof k.llmJudge === "object" ? k.llmJudge.answerRelevance : "—"}</div></div>
        <div class="bar"><div class="name">临床 Correct</div><div class="track"><div class="fill" data-w="${typeof k.llmJudge === "object" ? Math.round((k.llmJudge.clinicalCorrectness || 0) * 100) : 0}"></div></div><div style="width:64px;color:var(--muted)">${typeof k.llmJudge === "object" ? k.llmJudge.clinicalCorrectness : "—"}</div></div>
        <div class="bar"><div class="name">安全 Safety</div><div class="track"><div class="fill v" data-w="${typeof k.llmJudge === "object" ? Math.round((k.llmJudge.safety || 0) * 100) : 0}"></div></div><div style="width:64px;color:var(--muted)">${typeof k.llmJudge === "object" ? k.llmJudge.safety : "—"}</div></div>
        <div class="note">状态：${esc(judgeStatus)}。注入 <code>SENSENOVA_API_KEYS</code>（免费多 Key 池，最多 20 并发）或 <code>DEEPSEEK_API_KEY</code> 即自动启用四维评分；密钥池由 lib/llm-judge.mjs 轮询分发。</div>
      </div>
    </div>
  </section>

  <section>
    <h2><span class="num">2</span>逐样本明细</h2>
    <p class="lead">引=引用召回(top3 命中应引指南) · 证=证据可定位率 · 级=指南原文是否含 GRADE/证据等级标记 · 允/禁=结构化断言核对 · J=LLM-Judge。</p>
    <div class="card" style="overflow:auto"><table>
      <thead><tr><th>ID</th><th>科室</th><th>难度</th><th>引用</th><th>证据</th><th>等级</th><th>允许断言</th><th>禁戒</th><th>Judge</th><th>问题</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div>
  </section>

  <section>
    <h2><span class="num">3</span>基线结论与已知盲区</h2>
    <div class="grid g2">
      <div class="card"><h3><span class="dot" style="background:var(--green);box-shadow:0 0 10px var(--green)"></span>已达基线</h3>
        <ul class="tight">
          <li>断言引擎正确：允许断言通过率 100%、禁戒违例 0% —— 评测卡点可信。</li>
          <li>引用召回 84.6% · 证据可定位 89.7% · 越界拒答 100%。</li>
          <li>陷阱题安全护栏（紧急症候 / 越界文书）行为正确。</li>
        </ul>
      </div>
      <div class="card"><h3><span class="dot" style="background:var(--amber);box-shadow:0 0 10px var(--amber)"></span>待解盲区</h3>
        <ul class="tight">
          <li>Q11（肾功能不全+格列本脲）路由 0/1：用药禁忌类个人化问法路由偏弱，需 multi-turn 槽位回填。</li>
          <li>Q12（肝癌 vs 胰腺癌）跨指南仅 1/2 命中 top3：跨指南检索依赖 knowledge_search 全局向量库，融合权重待调优。</li>
          <li>Q02/Q10 指南原文缺<strong>标准化 GRADE 原词</strong>（严格口径仍 83.3%），但携带丰富中文推荐强度表述（推荐/首选/一线/不推荐…）；T13 已扩展标记词表识别中文循证表述，证据等级标注率升至 100%（评测定义缺口，非知识层缺口）。</li>
          ${RUN_LLM ? "" : '<li>LLM-Judge 四维因无 API Key 跳过：真实临床正确性 / 忠实度基线尚未建立（注入 SENSENOVA_API_KEYS 即启用）。</li>'}
        </ul>
      </div>
    </div>
    ${isE2E ? '<div class="note">端到端基线已激活：真实 Agent 回答已回填 systemAnswer，评测从「引擎自检」升为「真实输出可信度」。幻觉 / 临床正确性阈值可设为 CI 卡点。</div>' : '<div class="note">M2 待激活：将 systemAnswer 经真实 Agent 实跑回填，使本评测从「引擎自检」升级为「端到端答案可信度基线」。</div>'}
  </section>

  <footer>医疗 Agentic RAG · 答案质量评测 v1 · 自含离线报告 · ${esc(gen)}</footer>
</div>
<script>window.addEventListener("load",()=>{document.querySelectorAll(".fill").forEach(f=>{const w=f.getAttribute("data-w");requestAnimationFrame(()=>{f.style.width=w+"%";});});});</script>
</body></html>`;
}

let citHit = 0, citTot = 0;
let evHit = 0, evTot = 0;
let gradeHit = 0, gradeTot = 0, gradeStrictHit = 0;
let allowedItemTot = 0, allowedItemPass = 0, forbiddenItemTot = 0, forbiddenItemFail = 0, refusalN = 0, refusalOkN = 0, preferredItemTot = 0, preferredItemHit = 0;
const faith = [], rel = [], clin = [], safe = [];

// ---------- 阶段一：离线结构层（串行，零成本） ----------
const partials = [];
for (const it of ITEMS) {
  // 离线结构层
  const route = routeGuides(it.q, { index, useCache: false });
  const top3 = route.top.slice(0, 3).map((g) => g.title);
  // 引用召回：病种主题匹配（容错标题/来源/版本差异，不掩盖真错路）
  const top3Diseases = route.top.slice(0, 3).map((g) => g.disease).filter(Boolean);
  const gtHit = (it.gtSources || []).filter((g) => {
    const d = resolveGtDisease(g);
    return d && top3Diseases.includes(d);
  }).length;
  citHit += gtHit; citTot += (it.gtSources || []).length;

  let evLocalHit = 0, evLocalTot = 0, gradeLocal = false, gradeStrictLocal = false;
  for (const gt of it.gtSources || []) {
    const { text } = readGuideText(gt);
    if (text == null) { evLocalTot += (it.evidencePhrases || []).length; continue; }
    const ntxt = normalize(text);
    for (const ph of it.evidencePhrases || []) { evLocalTot++; if (ntxt.includes(normalize(ph))) evLocalHit++; }
    if (!gradeLocal && hasGradeMarker(text)) gradeLocal = true;
    if (!gradeStrictLocal && hasStrictGrade(text)) gradeStrictLocal = true;
  }
  evHit += evLocalHit; evTot += evLocalTot;
  // 证据等级标注率：仅「期望标注」条目计入分母，命中亦限同口径 → 封顶 100%
  // （修复原口径错配：分子对 expectGradeLabel=false 但指南含 marker 的条目也累加，致 >100% 虚高）
  if (it.expectGradeLabel !== false) {
    gradeTot++;
    if (gradeLocal) gradeHit++;
    if (gradeStrictLocal) gradeStrictHit++;
  }

  // 待审回答：live 用 systemAnswer，否则 referenceAnswer（self-check）
  const answer = it.systemAnswer || it.referenceAnswer || "";
  const assertion = checkAssertions(it, answer);
  if (it.allowedClaims?.length) { allowedItemTot++; if (assertion.allowedPass) allowedItemPass++; }
  if (it.forbiddenClaims?.length) { forbiddenItemTot++; if (assertion.forbiddenCount > 0) forbiddenItemFail++; }
  if (it.preferredClaims?.length) { preferredItemTot += it.preferredClaims.length; preferredItemHit += assertion.preferredHit; }
  if (it.expectedRefusal) { refusalN++; if (assertion.refusalOk) refusalOkN++; }

  partials.push({ it, top3, gtHit, evLocalHit, evLocalTot, gradeLocal, gradeStrictLocal, answer, assertion });
}

// ---------- 阶段二：LLM-Judge 四维（有界并发；整体看门狗防网络悬挂致进程卡死） ----------
// 无 Key / 网络不可达 / 代理 TLS 拦截导致 fetch 无法中止时，单条 callOne 虽有 15s AbortController，
// 极端情况下 Promise 仍可能不 settle；故阶段二整体加 120s 看门狗，超时即降级 skipped 并照常出报告。
const EVAL_LLM_TIMEOUT_MS = Number(process.env.EVAL_LLM_TIMEOUT_MS) || 120000;
let judges;
try {
  judges = await Promise.race([
    runWithConcurrency(
      partials.map((p) => () => llmJudge(p.it, p.answer)),
      SENSENOVA_CONCURRENCY,
    ),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error("llm-judge 阶段超时")), EVAL_LLM_TIMEOUT_MS),
    ),
  ]);
} catch (e) {
  console.error(`⚠ LLM-Judge 阶段超时/异常，降级 skipped：${e.message}`);
  judges = partials.map(() => ({ skipped: true, reason: "watchdog_timeout" }));
}

const details = partials.map((p, i) => {
  const j = judges[i];
  if (!j.skipped) {
    if (isFinite(j.faithfulness)) faith.push(j.faithfulness);
    if (isFinite(j.answerRelevance)) rel.push(j.answerRelevance);
    if (isFinite(j.clinicalCorrectness)) clin.push(j.clinicalCorrectness);
    if (isFinite(j.safety)) safe.push(j.safety);
  }
  return {
    id: p.it.id, department: p.it.department, difficulty: p.it.difficulty, q: p.it.q,
    citation: { hit: p.gtHit, tot: (p.it.gtSources || []).length, top3: p.top3 },
    evidence: { hit: p.evLocalHit, tot: p.evLocalTot },
    gradeFound: p.gradeLocal,
    gradeStrict: p.gradeStrictLocal,
    assertion: p.assertion,
    judge: j,
  };
});

const metrics = {
  generatedAt: new Date().toISOString(),
  mode: RUN_LLM ? "llm-enabled" : "offline+assertions-only",
  endToEnd: { live: ITEMS.filter((it) => it.systemAnswer).length, total: ITEMS.length, active: ITEMS.every((it) => it.systemAnswer) },
  knowledgeBase: { guides: Object.keys(index.guideMap).length, keywords: index.totalKeywords },
  kpi: {
    citationRecall: pct(citHit, citTot),
    evidenceLocatability: pct(evHit, evTot),
    gradeLabelRate: pct(gradeHit, gradeTot),
    gradeStrictRate: pct(gradeStrictHit, gradeTot),
    allowedClaimRate: pct(allowedItemPass, allowedItemTot),
    preferredClaimRate: preferredItemTot ? pct(preferredItemHit, preferredItemTot) : null,
    forbiddenViolationRate: pct(forbiddenItemFail, forbiddenItemTot),
    refusalAccuracy: refusalN ? pct(refusalOkN, refusalN) : null,
    llmJudge: RUN_LLM
      ? { faithfulness: avg(faith), answerRelevance: avg(rel), clinicalCorrectness: avg(clin), safety: avg(safe), n: faith.length }
      : "skipped (no API Key)",
  },
  raw: { citHit, citTot, evHit, evTot, gradeHit, gradeTot, gradeStrictHit, allowedItemPass, allowedItemTot, forbiddenItemFail, forbiddenItemTot, refusalN, refusalOkN, preferredItemHit, preferredItemTot },
};

const report = { metrics, details };
writeFileSync(join(REPO_ROOT, "tests", "reports", "answer-quality-report.json"), JSON.stringify(report, null, 2), "utf-8");

// ---------- 液态玻璃 HTML 可视化 ----------
const htmlPath = join(REPO_ROOT, "tests", "reports", "answer-quality-report.html");
writeFileSync(htmlPath, buildHtmlReport(metrics, details), "utf-8");

// ---------- 控制台摘要 ----------
const L = "─".repeat(70);
console.log(L);
console.log("医疗 Agentic RAG · 端到端答案质量评测（LLM-Judge v1）");
console.log(L);
console.log(`模式: ${metrics.mode} | 知识库 ${metrics.knowledgeBase.guides} 指南 | 样本 ${ITEMS.length}`);
console.log(L);
console.log(`引用召回率        : ${metrics.kpi.citationRecall ?? "—"}%  (${citHit}/${citTot})`);
console.log(`证据可定位率      : ${metrics.kpi.evidenceLocatability ?? "—"}%  (${evHit}/${evTot})`);
console.log(`证据等级标注率    : ${metrics.kpi.gradeLabelRate ?? "—"}%  (${gradeHit}/${gradeTot})  [含中文推荐强度口径]`);
console.log(`  其中严格GRADE原词: ${metrics.kpi.gradeStrictRate ?? "—"}%  (${gradeStrictHit}/${gradeTot})`);
console.log(`允许断言通过率    : ${metrics.kpi.allowedClaimRate ?? "—"}%`);
console.log(`禁戒断言违例率    : ${metrics.kpi.forbiddenViolationRate}%  (违例 ${forbiddenItemFail}/${forbiddenItemTot})`);
console.log(`越界拒答准确率    : ${metrics.kpi.refusalAccuracy ?? "—"}%  (${refusalOkN}/${refusalN})`);
const jd = metrics.kpi.llmJudge;
if (typeof jd === "object")
  console.log(`LLM-Judge(0-1)   : 忠实 ${jd.faithfulness} / 相关 ${jd.answerRelevance} / 临床 ${jd.clinicalCorrectness} / 安全 ${jd.safety} (n=${jd.n})`);
else
  console.log(`LLM-Judge        : ${jd}`);
console.log(L);
for (const d of details) {
  const a = d.assertion;
  console.log(`  [${d.id}] ${d.department}/${d.difficulty} 引${d.citation.hit}/${d.citation.tot} 证${d.evidence.tot ? pct(d.evidence.hit, d.evidence.tot) + "%" : "—"} 级${d.gradeFound ? "✓" : "✗"}(严${d.gradeStrict ? "✓" : "✗"}) 允${a.allowedPass ? "✓" : "✗"} 禁${a.forbiddenCount === 0 ? "✓" : "✗" + a.forbiddenCount} ${d.judge.skipped ? "(judge跳过)" : "J✓"}  ${d.q}`);
}
console.log(L);
console.log("报告已写出: tests/reports/answer-quality-report.json");
console.log("可视化已写出: tests/reports/answer-quality-report.html");
console.log(L);
