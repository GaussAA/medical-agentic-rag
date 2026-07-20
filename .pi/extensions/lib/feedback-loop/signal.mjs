// feedback-loop/signal.mjs — 信号采集

import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { diag } from "../diagnostic-log.mjs";

export const SEVERITY = { HIGH: "high", MEDIUM: "medium", LOW: "low" };

function evalDimensionsToSignals(item) {
  const out = [];
  const j = item?.llmJudge;
  if (!j) return out;
  const dims = [["faithfulness", j.faithfulness], ["answerRelevance", j.answerRelevance], ["clinicalCorrectness", j.clinicalCorrectness], ["safety", j.safety]];
  for (const [name, v] of dims) {
    if (typeof v !== "number") continue;
    if (v < 0.6) out.push({ src: "eval", type: `eval_low_${name}`, severity: SEVERITY.HIGH, guides: item?.guides || [], detail: `${name}=${v.toFixed(3)}` });
    else if (v < 0.8) out.push({ src: "eval", type: `eval_low_${name}`, severity: SEVERITY.MEDIUM, guides: item?.guides || [], detail: `${name}=${v.toFixed(3)}` });
  }
  return out;
}

function scanGuardHits(logsDir) {
  const signals = [];
  let files = [];
  try { files = readdirSync(logsDir).filter((f) => f.endsWith(".ndjson")); } catch { return signals; }
  for (const f of files) {
    const lines = readFileSync(join(logsDir, f), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e; try { e = JSON.parse(line); } catch { continue; }
      if (e?.event !== "guard_hit") continue;
      signals.push({ src: "guard_hit", type: `${e.type}_${e.action}`, severity: e.action === "block" ? SEVERITY.HIGH : SEVERITY.MEDIUM, guides: e.guides || [], detail: e.reason || "", t: e.t });
    }
  }
  return signals;
}

function scanEval(reportsDir) {
  const signals = [];
  const p = join(reportsDir, "answer-quality-report.json");
  if (!existsSync(p)) return signals;
  try { const rep = JSON.parse(readFileSync(p, "utf-8")); const items = rep?.items || []; for (const it of items) signals.push(...evalDimensionsToSignals(it)); }
  catch (e) { diag.warn("feedback-loop", "eval 报告解析失败: " + (e?.message || e)); }
  return signals;
}

function scanPhi(reportsDir) {
  const signals = [];
  const p = join(reportsDir, "observability-report.json");
  if (!existsSync(p)) return signals;
  try { const rep = JSON.parse(readFileSync(p, "utf-8")); const nonCompliant = rep?.phiAudit?.nonCompliant || []; for (const f of nonCompliant) signals.push({ src: "phi", type: "phi_noncompliant", severity: SEVERITY.HIGH, guides: [], detail: f, t: rep?.generatedAt }); }
  catch (e) { diag.warn("feedback-loop", "观测报告解析失败: " + (e?.message || e)); }
  return signals;
}

export function collectSignals({ logsDir, reportsDir } = {}) {
  const ld = logsDir || join(process.cwd(), ".pi/logs");
  const rd = reportsDir || join(process.cwd(), "tests", "reports");
  return [...scanGuardHits(ld), ...scanEval(rd), ...scanPhi(rd)];
}
