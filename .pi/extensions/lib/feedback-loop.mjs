// feedback-loop.mjs
// 维度五·持续反馈优化（MVP 核心层，纯 .mjs，双可测）。
//
// 职责：
//   把运行时已产生的"质量/安全信号"转化为"系统性薄弱点 → 改进建议"的闭环队列。
//   数据源（均来自前几役已落地的埋点，零新基础设施）：
//     1) logs/YYYY-MM-DD.ndjson 中的 guard_hit 事件（faithfulness/conflict 的 annotate/block）
//     2) tests/reports/answer-quality-report.json 的 llmJudge 四维低分
//     3) logs/observability-report.json 的 PHI 合规异常（维度四已聚合）
//
// 设计约束（严守 MEMORY 原则）：
//   - 纯聚合，绝不烧 LLM（免费额度留给运行时护栏），不重写任何端点。
//   - 合规：信号只含 type/guides/severity，绝不记 prompt 原文或患者 PII。
//   - 无静默失败：任一数据源读取失败 → 跳过该源 + 日志，不阻断其余聚合。
//   - 双可测：所有纯函数接受注入路径，原生 node 单测零真实 IO。
//
// 供 .ts 扩展（jiti）与原生 node 单测共用。

import { readdirSync, readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { logFeedbackGen } from "./observability.mjs";
import { diag } from "./diagnostic-log.mjs";

/** 严重度阈值（与 eval-ci-gate WARN 对齐：四维 <0.8 软、<0.6 硬）。 */
export const SEVERITY = {
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
};

/** 从一条 eval 记录判定薄弱维度 → 信号。 */
function evalDimensionsToSignals(item) {
  const out = [];
  const j = item?.llmJudge;
  if (!j) return out; // Q07 等 judge 为 null，跳过
  const dims = [
    ["faithfulness", j.faithfulness],
    ["answerRelevance", j.answerRelevance],
    ["clinicalCorrectness", j.clinicalCorrectness],
    ["safety", j.safety],
  ];
  for (const [name, v] of dims) {
    if (typeof v !== "number") continue;
    if (v < 0.6) out.push({ src: "eval", type: `eval_low_${name}`, severity: SEVERITY.HIGH, guides: item?.guides || [], detail: `${name}=${v.toFixed(3)}` });
    else if (v < 0.8) out.push({ src: "eval", type: `eval_low_${name}`, severity: SEVERITY.MEDIUM, guides: item?.guides || [], detail: `${name}=${v.toFixed(3)}` });
  }
  return out;
}

/** 扫描 logs/*.ndjson 提取 guard_hit 信号。 */
function scanGuardHits(logsDir) {
  const signals = [];
  let files = [];
  try {
    files = readdirSync(logsDir).filter((f) => f.endsWith(".ndjson"));
  } catch {
    return signals; // 目录不存在 → 跳过，不静默失败
  }
  for (const f of files) {
    const lines = readFileSync(join(logsDir, f), "utf-8").split("\n").filter(Boolean);
    for (const line of lines) {
      let e;
      try {
        e = JSON.parse(line);
      } catch {
        continue;
      }
      if (e?.event !== "guard_hit") continue;
      const sev = e.action === "block" ? SEVERITY.HIGH : SEVERITY.MEDIUM;
      signals.push({
        src: "guard_hit",
        type: `${e.type}_${e.action}`,
        severity: sev,
        guides: e.guides || [],
        detail: e.reason || "",
        t: e.t,
      });
    }
  }
  return signals;
}

/** 扫描 eval 报告低分信号。 */
function scanEval(reportsDir) {
  const signals = [];
  const p = join(reportsDir, "answer-quality-report.json");
  if (!existsSync(p)) return signals;
  try {
    const rep = JSON.parse(readFileSync(p, "utf-8"));
    const items = rep?.items || [];
    for (const it of items) signals.push(...evalDimensionsToSignals(it));
  } catch (e) {
    diag.warn("feedback-loop", "eval 报告解析失败，跳过: " + (e?.message || e));
  }
  return signals;
}

/** 扫描维度四观测报告的 PHI 合规异常信号。 */
function scanPhi(reportsDir) {
  const signals = [];
  const p = join(reportsDir, "observability-report.json");
  if (!existsSync(p)) return signals;
  try {
    const rep = JSON.parse(readFileSync(p, "utf-8"));
    const nonCompliant = rep?.phiAudit?.nonCompliant || [];
    for (const f of nonCompliant) {
      signals.push({ src: "phi", type: "phi_noncompliant", severity: SEVERITY.HIGH, guides: [], detail: f, t: rep?.generatedAt });
    }
  } catch (e) {
    diag.warn("feedback-loop", "观测报告解析失败，跳过: " + (e?.message || e));
  }
  return signals;
}

/**
 * 收集全部信号（注入路径便于单测）。
 * @param {{logsDir?:string, reportsDir?:string}} [opts]
 * @returns {Array<{src:string, type:string, severity:string, guides:string[], detail:string, t?:string}>}
 */
export function collectSignals({ logsDir, reportsDir } = {}) {
  const ld = logsDir || join(process.cwd(), "logs");
  const rd = reportsDir || join(process.cwd(), "tests", "reports");
  return [...scanGuardHits(ld), ...scanEval(rd), ...scanPhi(rd)];
}

/**
 * 按 (type, guides 排序键) 分组计数 → 热点。
 * @param {Array} signals  collectSignals 返回的信号数组
 * @returns {Array<{type:string, src:string, guides:string[], count:number, severity:string}>}
 */
export function aggregateHotspots(signals) {
  const map = new Map();
  for (const s of signals) {
    const gkey = [...(s.guides || [])].sort().join("|");
    const key = `${s.type}::${gkey}`;
    if (!map.has(key)) {
      map.set(key, { type: s.type, src: s.src, guides: s.guides || [], count: 0, severity: SEVERITY.LOW });
    }
    const h = map.get(key);
    h.count += 1;
    // 严重度取最高
    const rank = { low: 0, medium: 1, high: 2 };
    if (rank[s.severity] > rank[h.severity]) h.severity = s.severity;
  }
  return [...map.values()].sort((a, b) => b.count - a.count || rank(b.severity) - rank(a.severity));
}

function rank(sev) {
  return { low: 0, medium: 1, high: 2 }[sev] || 0;
}

/**
 * 热点 → 改进建议（纯规则，不烧 LLM）。
 * @param {Array} hotspots  aggregateHotspots 返回的热点数组
 * @returns {Array<{type:string, src:string, guides:string[], count:number, severity:string, suggestion:string}>}
 */
export function buildSuggestions(hotspots) {
  return hotspots.map((h) => {
    let suggestion = "";
    const guides = h.guides && h.guides.length ? h.guides.join(" / ") : "（未关联具体指南）";
    if (h.type.startsWith("conflict_")) {
      suggestion = `跨指南冲突热点（${guides}）：建议人工对齐各指南推荐差异，或补录该领域现行指南以消除分歧。`;
    } else if (h.type.startsWith("faithfulness_block")) {
      suggestion = `忠实度硬阻断热点：建议在系统提示中强化该领域的循证引用约束，并复盘被阻断回答的根因。`;
    } else if (h.type.startsWith("faithfulness_annotate")) {
      suggestion = `忠实度标注热点：建议补充该领域的 gold 评测样例，强化模型循证表述。`;
    } else if (h.type.startsWith("eval_low_")) {
      suggestion = `评测低分热点（${h.type.replace("eval_low_", "")}）：建议补充对应维度的 gold 样例与知识库覆盖。`;
    } else if (h.type === "phi_noncompliant") {
      suggestion = `PHI 合规异常：立即排查对应日志的脱敏/审计逻辑，确保无患者隐私落盘。`;
    } else {
      suggestion = `观察到 ${h.type} 信号，建议人工复盘。`;
    }
    return { ...h, suggestion };
  });
}

/**
 * 组装反馈队列（聚合 + 建议 + 元信息）。
 * @param {{logsDir?:string, reportsDir?:string, generatedAt?:string}} [opts]
 * @returns {{generatedAt:string, summary:{totalSignals:number, high:number, medium:number, low:number, hotspotCount:number}, hotspots:Array, signals:Array}}
 */
export function buildFeedbackQueue({ logsDir, reportsDir, generatedAt } = {}) {
  const signals = collectSignals({ logsDir, reportsDir });
  const hotspots = aggregateHotspots(signals);
  const suggestions = buildSuggestions(hotspots);
  const summary = {
    totalSignals: signals.length,
    high: signals.filter((s) => s.severity === SEVERITY.HIGH).length,
    medium: signals.filter((s) => s.severity === SEVERITY.MEDIUM).length,
    low: signals.filter((s) => s.severity === SEVERITY.LOW).length,
    hotspotCount: hotspots.length,
  };
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    summary,
    hotspots: suggestions,
    signals: signals.slice(0, 200), // 截断防膨胀，完整信号见源日志
  };
}

/**
 * 写盘（注入路径便于单测隔离）。
 * @param {object} queue  buildFeedbackQueue 返回的队列对象
 * @param {string} [outPath]  输出路径，默认 logs/feedback-queue.json
 * @returns {string} 实际写入路径
 */
export function writeFeedbackQueue(queue, outPath, logsDir) {
  const dir = outPath || join(process.cwd(), "logs", "feedback-queue.json");
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(dir, JSON.stringify(queue, null, 2), "utf-8");
  // 观测：反馈生成计数（fire-and-forget，不阻断写盘）；默认与队列同目录（logs/），单测注入 tmp 则隔离
  const ld = logsDir || join(dir, "..");
  logFeedbackGen({
    signals: queue?.summary?.totalSignals,
    hotspots: queue?.summary?.hotspotCount,
    suggestions: Array.isArray(queue?.hotspots) ? queue.hotspots.length : undefined,
    topSeverity:
      Array.isArray(queue?.hotspots) && queue.hotspots.length
        ? queue.hotspots[0].severity
        : undefined,
    logsDir: ld,
  }).catch(() => {});
  return dir;
}

/**
 * 读取已生成的反馈队列（消费端入口）。
 * @param {string} [path]  队列路径，默认 logs/feedback-queue.json
 * @returns {object|null}  解析后的队列对象；缺失/损坏返回 null（不静默崩，留痕）
 */
export function readFeedbackQueue(path) {
  const p = path || join(process.cwd(), "logs", "feedback-queue.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch (e) {
    diag.warn("feedback-loop", "队列读取失败，返回 null: " + (e?.message || e));
    return null;
  }
}

/**
 * 读取已解决热点 key 集合（人工/自动标记后跳过，避免重复消费）。
 * key 格式： `${type}::${guides 排序后 join("|")}`
 * @param {string} [path]  默认 logs/feedback-resolved.json
 * @returns {Set<string>}
 */
export function loadResolved(path) {
  const p = path || join(process.cwd(), "logs", "feedback-resolved.json");
  if (!existsSync(p)) return new Set();
  try {
    const arr = JSON.parse(readFileSync(p, "utf-8"));
    return new Set(Array.isArray(arr) ? arr : arr?.keys || []);
  } catch {
    return new Set();
  }
}

/**
 * 标记热点为已解决（追加 key，去重）。
 * @param {string[]} keys  热点 key 数组
 * @param {string} [path]  默认 logs/feedback-resolved.json
 * @returns {string[]}  本次新增的 key
 */
export function resolveFeedback(keys, path) {
  const p = path || join(process.cwd(), "logs", "feedback-resolved.json");
  const set = loadResolved(p);
  const added = [];
  for (const k of keys) {
    if (!set.has(k)) {
      set.add(k);
      added.push(k);
    }
  }
  if (added.length) {
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, JSON.stringify([...set], null, 2), "utf-8");
  }
  return added;
}

/**
 * 把可改进的热点派生为 gold 候选（补 P2-① gold 薄偏科素材）。
 * 仅抽取与"评测/忠实度"直接相关的薄弱点；冲突/PHI 类不构成评测题，跳过。
 * 纯函数，不写任何文件（写盘由调用方决定，避免污染受控 gold-answers.json）。
 * @param {{hotspots?:Array}} queue  含 hotspots 数组的对象（或直接传 hotspots）
 * @param {{existingIds?:string[]}} [opts]  已有候选/题 id，去重
 * @returns {Array<{id:string, fromType:string, department:string, guides:string[], severity:string, count:number, rationale:string, status:string}>}
 */
export function deriveGoldCandidates(queue, { existingIds = [] } = {}) {
  const hotspots = Array.isArray(queue) ? queue : queue?.hotspots || [];
  const idSet = new Set(existingIds);
  const cands = [];
  for (const h of hotspots) {
    const isGoldWorthy =
      h.type.startsWith("eval_low_") ||
      h.type.startsWith("faithfulness_annotate") ||
      h.type.startsWith("faithfulness_block");
    if (!isGoldWorthy) continue;
    const dept = (h.guides?.[0] || "（未关联指南）").replace(/[（(].*$/, "");
    const seed = h.guides?.map((g) => g.slice(0, 4)).join("_") || "na";
    const id = `CAND-${h.type}-${seed}`.replace(/[^A-Za-z0-9_-]/g, "");
    if (idSet.has(id)) continue;
    cands.push({
      id,
      fromType: h.type,
      department: dept,
      guides: h.guides || [],
      severity: h.severity,
      count: h.count,
      rationale: h.suggestion,
      status: "candidate",
    });
  }
  return cands;
}

/**
 * 编排消费：读队列 → 跳已解决 → 派生 gold 候选 → 产出回灌记录。
 * @param {{queuePath?:string, resolvedPath?:string, existingIds?:string[]}} [opts]
 * @returns {{consumed:boolean, consumedAt:string, totalHotspots:number, openHotspots:number, resolvedSkipped:number, goldCandidates:Array, reason?:string}}
 */
export function consumeFeedback({ queuePath, resolvedPath, existingIds = [] } = {}) {
  const queue = readFeedbackQueue(queuePath);
  if (!queue) {
    return { consumed: false, reason: "no-queue", consumedAt: new Date().toISOString(), totalHotspots: 0, openHotspots: 0, resolvedSkipped: 0, goldCandidates: [] };
  }
  const resolved = loadResolved(resolvedPath);
  const all = queue.hotspots || [];
  const open = all.filter((h) => {
    const key = `${h.type}::${[...(h.guides || [])].sort().join("|")}`;
    return !resolved.has(key);
  });
  const goldCandidates = deriveGoldCandidates({ hotspots: open }, { existingIds });
  return {
    consumed: true,
    consumedAt: new Date().toISOString(),
    totalHotspots: all.length,
    openHotspots: open.length,
    resolvedSkipped: all.length - open.length,
    goldCandidates,
  };
}

/**
 * 写回灌记录（消费端产物，注入路径便于单测）。
 * @param {object} record  consumeFeedback 返回对象
 * @param {string} [outPath]  默认 tests/reports/feedback-consumed.json
 * @returns {string} 实际路径
 */
export function writeConsumed(record, outPath) {
  const p = outPath || join(process.cwd(), "tests", "reports", "feedback-consumed.json");
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, JSON.stringify(record, null, 2), "utf-8");
  return p;
}
