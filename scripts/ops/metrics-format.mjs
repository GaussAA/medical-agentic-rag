// scripts/ops/metrics-format.mjs
// 医疗 Agentic RAG —— Prometheus 指标采集与渲染（共享模块）
//
// 抽出自 metrics-exporter.mjs，供「指标导出器」与「API 服务 /metrics」复用，
// 避免重复实现。纯 node、零依赖。
//
// 采集源：项目 cwd 下 .pi/logs/audit-*.ndjson 审计日志。
// 输出指标：
//   - medical_rag_up                       运行中(1)
//   - medical_rag_audit_events_total{event}  按事件类型计数
//   - medical_rag_safety_guard_hits_total   安全护栏触发总数
//   - medical_rag_last_event_ts             最近一次事件 unix 时间戳
//   - medical_rag_exporter_uptime_seconds   导出器运行时长

import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// 安全护栏相关事件关键字（用于聚合 guard hits）
const GUARD_KEYWORDS = [
  "guard", "faithfulness", "conflict", "scope", "phi", "patient",
  "safety", "audit", "block", "reject",
];

export function eventKey(evt) {
  return (
    evt?.event || evt?.type || evt?.action || evt?.kind || "unknown"
  );
}

export function isGuardHit(key) {
  const k = String(key).toLowerCase();
  return GUARD_KEYWORDS.some((kw) => k.includes(kw));
}

export function collectAuditMetrics(logDir) {
  const counters = new Map();
  let guardHits = 0;
  let lastTs = 0;

  if (!logDir || !existsSync(logDir)) return { counters, guardHits, lastTs };

  let files = [];
  try {
    files = readdirSync(logDir).filter(
      (f) => f.startsWith("audit-") && f.endsWith(".ndjson")
    );
  } catch {
    return { counters, guardHits, lastTs };
  }

  for (const f of files) {
    const path = join(logDir, f);
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split("\n")) {
      const s = line.trim();
      if (!s) continue;
      let evt;
      try {
        evt = JSON.parse(s);
      } catch {
        continue;
      }
      const key = eventKey(evt);
      counters.set(key, (counters.get(key) || 0) + 1);
      if (isGuardHit(key)) guardHits++;
      const ts =
        (evt?.ts && Date.parse(evt.ts)) ||
        (evt?.timestamp && Date.parse(evt.timestamp)) ||
        0;
      if (ts > lastTs) lastTs = ts;
    }
  }
  return { counters, guardHits, lastTs: Math.floor(lastTs / 1000) };
}

// 渲染 Prometheus 文本格式。startedAt 由调用方传入（保证 uptime 一致）。
export function renderMedicalRagMetrics(logDir, startedAt = Date.now()) {
  const { counters, guardHits, lastTs } = collectAuditMetrics(logDir);
  const lines = [];
  lines.push("# HELP medical_rag_up Exporter is alive");
  lines.push("# TYPE medical_rag_up gauge");
  lines.push("medical_rag_up 1");

  lines.push("# HELP medical_rag_audit_events_total Audit events by type");
  lines.push("# TYPE medical_rag_audit_events_total counter");
  for (const [k, v] of [...counters.entries()].sort()) {
    lines.push(`medical_rag_audit_events_total{event="${k}"} ${v}`);
  }

  lines.push("# HELP medical_rag_safety_guard_hits_total Safety guard triggers total");
  lines.push("# TYPE medical_rag_safety_guard_hits_total counter");
  lines.push(`medical_rag_safety_guard_hits_total ${guardHits}`);

  lines.push("# HELP medical_rag_last_event_ts Unix timestamp of last audit event");
  lines.push("# TYPE medical_rag_last_event_ts gauge");
  lines.push(`medical_rag_last_event_ts ${lastTs}`);

  lines.push("# HELP medical_rag_exporter_uptime_seconds Exporter uptime");
  lines.push("# TYPE medical_rag_exporter_uptime_seconds gauge");
  lines.push(`medical_rag_exporter_uptime_seconds ${Math.floor((Date.now() - startedAt) / 1000)}`);

  return lines.join("\n") + "\n";
}
