// observability-report.mjs
// 可观测性聚合报告（维度四「观测埋点进 CI」MVP）
//
// 数据源（全为既有产出，零新采集点，除护栏 guard_hit 埋点为本次新增）：
//   A) logs/YYYY-MM-DD.ndjson   —— monitor-logger 会话/prompt 计数 + 本次新增的 guard_hit 护栏命中
//   B) logs/audit-YYYY-MM-DD.ndjson —— PHI 读写审计（合规扫描：不得含 prompt 原文）
//   C) tests/reports/answer-quality-report.json —— 端到端答案质量 KPI + 四维 Judge
//   D) 静态护栏部署检查 —— faithfulness/conflict 扩展文件存在 + System Prompt 含对应说明 + 未旁路 off
//
// 输出：logs/observability-report.json + 控制台摘要。
// CI 语义：WARN 级（默认不阻断，仅高亮 warnings）；--strict 升级为退出码 1。
//
// 显式错误捕获：任一数据源缺失/损坏 → 该维度标记为 unknown 并记 warning，不整体崩溃（无静默失败）。
//
// 纯 .mjs（无 TS 语法），既能 node 直接跑，也能被原生 node 单测 import。

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

// ---------- 读取辅助 ----------
function loadAllNdjson(dir) {
  if (!dir || !existsSync(dir)) return [];
  let files = [];
  try {
    files = readdirSync(dir).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    const kind = f.includes("audit") ? "audit" : "biz";
    let text = "";
    try {
      text = readFileSync(join(dir, f), "utf-8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const t = line.trim();
      if (!t) continue;
      try {
        const o = JSON.parse(t);
        o.__kind = kind;
        out.push(o);
      } catch {
        /* 坏行跳过 */
      }
    }
  }
  return out;
}

/** 合规扫描：业务 prompt 事件仅允许 {t,event,promptLength,hasImages}，不得含 prompt 原文；audit 不得含 prompt 事件。 */
function scanPhiCompliance(all) {
  let compliant = true;
  const reasons = [];
  const allowedPromptKeys = new Set(["t", "event", "promptLength", "hasImages"]);
  for (const e of all) {
    if (e.__kind === "biz" && e.event === "prompt") {
      const keys = Object.keys(e);
      const extra = keys.filter((k) => !allowedPromptKeys.has(k) && k !== "__kind");
      if (extra.length > 0) {
        compliant = false;
        reasons.push(`业务 prompt 事件含非允许字段: ${extra.join(",")}`);
      }
    }
    if (e.__kind === "audit" && e.event === "prompt") {
      compliant = false;
      reasons.push("audit 日志出现 prompt 事件（疑似泄漏用户原文）");
    }
  }
  return { compliant, reasons };
}

/** 静态护栏部署检查（文件存在 + System Prompt 含说明 + 未旁路 off）。 */
function checkGuardsDeployed(cwd) {
  const extDir = join(cwd, ".pi", "extensions");
  const faithFile = join(extDir, "safety.faithfulness-guard.ts");
  const conflictFile = join(extDir, "safety.conflict-detector.ts");
  const spFile = join(cwd, "prompts", "medical-agent.md");

  const faithfulnessFile = existsSync(faithFile);
  const conflictFileOk = existsSync(conflictFile);
  let spMentions = { faithfulness: false, conflict: false };
  try {
    const sp = readFileSync(spFile, "utf-8");
    spMentions.faithfulness = sp.includes("自动循证护栏");
    spMentions.conflict = sp.includes("跨指南冲突自动提示");
  } catch {
    /* System Prompt 读不到 → 视为未部署说明 */
  }

  const faithfulness = faithfulnessFile && spMentions.faithfulness && process.env.FAITHFULNESS_GUARD !== "off";
  const conflict = conflictFileOk && spMentions.conflict && process.env.CONFLICT_DETECT !== "off";
  return { faithfulness, conflict };
}

// ---------- 主聚合 ----------
/**
 * @param {string} logsDir  业务/审计 ndjson 目录
 * @param {string} reportsDir answer-quality-report.json 目录
 * @param {string} cwd  项目根（用于静态护栏检查）
 */
export function aggregate(logsDir, reportsDir, cwd = process.cwd()) {
  const all = loadAllNdjson(logsDir);
  const biz = all.filter((e) => e.__kind === "biz");
  const audit = all.filter((e) => e.__kind === "audit");

  const sessions = biz.filter((e) => e.event === "session_start").length;
  const prompts = biz.filter((e) => e.event === "prompt").length;

  // 护栏命中计数
  const guardHitsRaw = biz.filter((e) => e.event === "guard_hit");
  const guardHits = {
    faithfulness: { annotate: 0, block: 0 },
    conflict: { annotate: 0, block: 0 },
    total: guardHitsRaw.length,
  };
  for (const g of guardHitsRaw) {
    const bucket = guardHits[g.type];
    if (bucket && (g.action === "annotate" || g.action === "block")) bucket[g.action]++;
  }

  // PHI 审计
  const phiAudit = { entries: audit.length, ...scanPhiCompliance(all) };

  // Eval 质量基线
  let evalData = { available: false };
  try {
    const p = join(reportsDir, "answer-quality-report.json");
    if (existsSync(p)) {
      const r = JSON.parse(readFileSync(p, "utf-8"));
      const kpi = r.metrics?.kpi || {};
      const j = kpi.llmJudge || {};
      // 过滤 null（judge 跳过/失败）后取均值
      const dims = ["faithfulness", "answerRelevance", "clinicalCorrectness", "safety"];
      const avg = {};
      let n = 0;
      for (const d of dims) {
        const vals = (r.details || [])
          .map((x) => x.judge?.[d])
          .filter((v) => typeof v === "number" && !isNaN(v));
        avg[d] = vals.length ? Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)) : null;
        if (typeof j.n === "number") n = j.n;
      }
      evalData = {
        available: true,
        sampleN: r.metrics?.endToEnd?.live ?? null,
        citationRecall: kpi.citationRecall ?? null,
        evidenceLocatability: kpi.evidenceLocatability ?? null,
        gradeLabelRate: kpi.gradeLabelRate ?? null,
        forbiddenViolationRate: kpi.forbiddenViolationRate ?? null,
        refusalAccuracy: kpi.refusalAccuracy ?? null,
        judge: { ...avg, n },
      };
    }
  } catch (e) {
    evalData = { available: false, error: String(e?.message || e) };
  }

  const guardsDeployed = checkGuardsDeployed(cwd);

  // 健康度 WARN 断言（不阻断）
  const warnings = [];
  if (evalData.available) {
    const j = evalData.judge || {};
    for (const d of ["faithfulness", "answerRelevance", "clinicalCorrectness", "safety"]) {
      if (typeof j[d] === "number" && j[d] < 0.8) warnings.push(`eval.${d} < 0.8 (实测 ${j[d]})`);
    }
    if (typeof evalData.citationRecall === "number" && evalData.citationRecall < 70)
      warnings.push(`引用召回率 < 70% (实测 ${evalData.citationRecall})`);
  } else {
    warnings.push("eval 报告不可用，无法校验质量基线");
  }
  if (!guardsDeployed.faithfulness) warnings.push("faithfulness 护栏未完整部署（文件/SP说明/旁路）");
  if (!guardsDeployed.conflict) warnings.push("conflict 护栏未完整部署（文件/SP说明/旁路）");
  if (!phiAudit.compliant) warnings.push("PHI 审计合规扫描未通过：" + (phiAudit.reasons || []).join("; "));

  return {
    generatedAt: new Date().toISOString(),
    sources: { logsDir, reportsDir },
    sessions,
    prompts,
    guardHits,
    phiAudit,
    eval: evalData,
    guardsDeployed,
    health: { overall: warnings.length ? "warn" : "healthy", warnings },
  };
}

// ---------- 运行入口 ----------
function printSummary(r) {
  const line = (k, v) => console.log(`  ${k.padEnd(22)} ${v}`);
  console.log("====== 医疗 Agentic RAG · 可观测性报告 ======");
  line("会话数", r.sessions);
  line("交互(prompt)数", r.prompts);
  line("护栏命中(总)", r.guardHits.total);
  line("  · faithfulness", `annotate=${r.guardHits.faithfulness.annotate}, block=${r.guardHits.faithfulness.block}`);
  line("  · conflict", `annotate=${r.guardHits.conflict.annotate}, block=${r.guardHits.conflict.block}`);
  line("PHI 审计条目", r.phiAudit.entries);
  line("PHI 合规", r.phiAudit.compliant ? "✅" : "❌");
  if (r.eval.available) {
    line("质量样本数", r.eval.sampleN);
    line("引用召回率", r.eval.citationRecall + "%");
    line("四维(忠/切/临/安)", [r.eval.judge.faithfulness, r.eval.judge.answerRelevance, r.eval.judge.clinicalCorrectness, r.eval.judge.safety].join(" / "));
  } else {
    line("eval", "不可用");
  }
  line("护栏部署", `faith=${r.guardsDeployed.faithfulness ? "✅" : "❌"}, conflict=${r.guardsDeployed.conflict ? "✅" : "❌"}`);
  line("整体健康", r.health.overall);
  if (r.health.warnings.length) {
    console.log("⚠️ 警告:");
    for (const w of r.health.warnings) console.log("  - " + w);
  }
}

// 直接运行（node scripts/ops/observability-report.mjs [--strict]）
const isMain = import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const cwd = process.cwd();
  const logsDir = join(cwd, ".pi", "logs");
  const reportsDir = join(cwd, "tests", "reports");
  const report = aggregate(logsDir, reportsDir, cwd);
  try {
    mkdirSync(logsDir, { recursive: true });
    writeFileSync(join(logsDir, "observability-report.json"), JSON.stringify(report, null, 2), "utf-8");
  } catch (e) {
    console.error("[observability] 报告写入失败:", e?.message || e);
  }
  printSummary(report);
  const strict = process.argv.includes("--strict");
  process.exit(report.health.warnings.length && strict ? 1 : 0);
}
