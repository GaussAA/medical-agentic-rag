// feedback-loop/queue.mjs — 队列构建/读写/解决管理

import { existsSync, writeFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { collectSignals } from "./signal.mjs";
import { aggregateHotspots, buildSuggestions } from "./aggregate.mjs";
import { logFeedbackGen } from "../observability.mjs";
import { diag } from "../diagnostic-log.mjs";

export function buildFeedbackQueue({ logsDir, reportsDir, generatedAt } = {}) {
  const signals = collectSignals({ logsDir, reportsDir });
  const hotspots = aggregateHotspots(signals);
  const suggestions = buildSuggestions(hotspots);
  return {
    generatedAt: generatedAt || new Date().toISOString(),
    summary: { totalSignals: signals.length, high: signals.filter((s) => s.severity === "high").length, medium: signals.filter((s) => s.severity === "medium").length, low: signals.filter((s) => s.severity === "low").length, hotspotCount: hotspots.length },
    hotspots: suggestions,
    signals: signals.slice(0, 200),
  };
}

export function writeFeedbackQueue(queue, outPath, logsDir) {
  const dir = outPath || join(process.cwd(), ".pi/logs", "feedback-queue.json");
  mkdirSync(join(dir, ".."), { recursive: true });
  writeFileSync(dir, JSON.stringify(queue, null, 2), "utf-8");
  const ld = logsDir || join(dir, "..");
  logFeedbackGen({ signals: queue?.summary?.totalSignals, hotspots: queue?.summary?.hotspotCount, suggestions: Array.isArray(queue?.hotspots) ? queue.hotspots.length : undefined, topSeverity: Array.isArray(queue?.hotspots) && queue.hotspots.length ? queue.hotspots[0].severity : undefined, logsDir: ld }).catch(() => {});
  return dir;
}

export function readFeedbackQueue(path) {
  const p = path || join(process.cwd(), ".pi/logs", "feedback-queue.json");
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, "utf-8")); } catch (e) { diag.warn("feedback-loop", "队列读取失败: " + (e?.message || e)); return null; }
}

export function loadResolved(path) {
  const p = path || join(process.cwd(), ".pi/logs", "feedback-resolved.json");
  if (!existsSync(p)) return new Set();
  try { const arr = JSON.parse(readFileSync(p, "utf-8")); return new Set(Array.isArray(arr) ? arr : arr?.keys || []); } catch { return new Set(); }
}

export function resolveFeedback(keys, path) {
  const p = path || join(process.cwd(), ".pi/logs", "feedback-resolved.json");
  const set = loadResolved(p);
  const added = [];
  for (const k of keys) { if (!set.has(k)) { set.add(k); added.push(k); } }
  if (added.length) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, JSON.stringify([...set], null, 2), "utf-8"); }
  return added;
}
