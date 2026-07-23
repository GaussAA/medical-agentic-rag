// observability.mjs
// 可观测性共享埋点库（纯 .mjs，双可测）。
//
// 职责（闭环 P2-③「埋点过窄」——原仅 guard_hit 单一维度）：
//   1) logGuardHit —— 护栏命中（faithfulness/conflict/scope 三护栏共用），
//      写入与 monitor-logger 同源的 logs/YYYY-MM-DD.ndjson（schema：{t,event,...}）。
//   2) logRetrieval —— 检索维度（召回条数/耗时/引擎模式/KB 解析），定位慢检索与零召回。
//   3) logEngineFallback —— 引擎不可用退回 BM25 的观测信号（脆弱点可见化，呼应 engine 升级加固）。
//   4) logFaithfulness —— 忠实度评审软信号（含放行的低分），弥补 guard_hit 仅覆盖硬阻断的盲区。
//   5) logAuditEvent —— 审计链事件聚合到同一 ndjson，会话级审计与护栏统一可聚合。
//   6) logFeedbackGen —— 反馈队列生成计数（信号/热点/建议/最高严重度），闭环可观测。
//   7) 合规：只记字段名/计数/长度/模式等元数据，绝不记 prompt 原文或患者 PII。
//   8) 失败哲学：fire-and-forget + catch stderr，绝不因埋点故障阻断主流程（无静默失败）。
//
// 供 .ts 扩展（jiti）与原生 node 单测共用。

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { diag } from "./diagnostic-log.mjs";
import { alert } from "./alert-log.mjs";

const EVENTS = new Set([
  "guard_hit",
  "retrieval",
  "engine_fallback",
  "faithfulness",
  "audit_event",
  "feedback_gen",
]);

/**
 * 统一事件写出（fire-and-forget + stderr 告警，无静默失败）。
 * @param {string} event  事件类型（须在 EVENTS 内）
 * @param {object} fields 附加字段
 * @param {string} [logsDir]  输出目录，默认 process.cwd()/logs
 */
async function emit(event, fields = {}, logsDir) {
  if (!EVENTS.has(event)) {
    diag.warn("observability", "未知事件类型，跳过: " + event);
    return;
  }
  try {
    const dir = logsDir || join(process.cwd(), ".pi/logs");
    await mkdir(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const entry =
      JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + "\n";
    await appendFile(join(dir, `${date}.ndjson`), entry, "utf-8");
  } catch (e) {
    alert("observability", `${event} 日志写入失败: ${e?.message || e}`);
  }
}

/**
 * 记录一次护栏命中（annotate / block / refuse）。
 * @param {object} p { type:'faithfulness'|'conflict'|'scope', action:'annotate'|'block'|'refuse', reason?, guides? }
 */
export async function logGuardHit({ type, action, reason, guides, logsDir } = {}) {
  return emit(
    "guard_hit",
    { type, action, reason: reason || undefined, guides: guides || undefined },
    logsDir,
  );
}

/**
 * 检索维度埋点：召回条数 / 耗时 / 引擎模式 / KB 解析结果。
 * @param {object} p { queryLen?, kbId?, kbResolved?, hits?, totalFiles?, ms?, engineMode? }
 */
export function logRetrieval({ queryLen, kbId, kbResolved, hits, totalFiles, ms, engineMode, logsDir } = {}) {
  return emit(
    "retrieval",
    {
      queryLen: typeof queryLen === "number" ? queryLen : undefined,
      kbId: kbId || null,
      kbResolved: !!kbResolved,
      hits: typeof hits === "number" ? hits : undefined,
      totalFiles: typeof totalFiles === "number" ? totalFiles : undefined,
      ms: typeof ms === "number" ? ms : undefined,
      engineMode: engineMode || undefined,
    },
    logsDir,
  );
}

/**
 * 引擎不可用退回 BM25 的观测信号。
 * @param {object} p { reason? }
 */
export function logEngineFallback({ reason, logsDir } = {}) {
  return emit("engine_fallback", { reason: reason || undefined }, logsDir);
}

/**
 * 忠实度评审软信号（含放行的低分），弥补 guard_hit 仅覆盖硬阻断的盲区。
 * @param {object} p { action?, score?, reason? }
 */
export function logFaithfulness({ action, score, reason, logsDir } = {}) {
  return emit(
    "faithfulness",
    {
      action: action || undefined,
      score: typeof score === "number" ? score : undefined,
      reason: reason || undefined,
    },
    logsDir,
  );
}

/**
 * 审计链事件聚合（与会话级审计同源，统一落 ndjson 便于聚合）。
 * @param {object} p { action? }
 */
export function logAuditEvent({ action, logsDir } = {}) {
  return emit("audit_event", { action }, logsDir);
}

/**
 * 反馈队列生成计数。
 * @param {object} p { signals?, hotspots?, suggestions?, topSeverity? }
 */
export function logFeedbackGen({ signals, hotspots, suggestions, topSeverity, logsDir } = {}) {
  return emit(
    "feedback_gen",
    {
      signals: typeof signals === "number" ? signals : undefined,
      hotspots: typeof hotspots === "number" ? hotspots : undefined,
      suggestions: typeof suggestions === "number" ? suggestions : undefined,
      topSeverity: topSeverity || undefined,
    },
    logsDir,
  );
}

export { EVENTS };
