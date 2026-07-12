// observability.mjs
// 可观测性共享埋点库（纯 .mjs，双可测）。
//
// 职责：
//   1) logGuardHit —— 护栏命中事件结构化落盘（faithfulness / conflict 两护栏共用），
//      写入与 monitor-logger 同源的 logs/YYYY-MM-DD.ndjson（同一 schema：{t,event,...}）。
//   2) 合规：只记 type/action/reason/guides，绝不记 prompt 原文或患者 PII（与 monitor-logger 同源原则）。
//   3) 失败哲学：fire-and-forget + catch stderr，绝不因埋点故障阻断主流程（无静默失败，仅告警）。
//
// 供 .ts 扩展（jiti）与原生 node 单测共用。

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 记录一次护栏命中（annotate / block）。
 * @param {object} p { type:'faithfulness'|'conflict', action:'annotate'|'block', reason?, guides? }
 */
export async function logGuardHit({ type, action, reason, guides, logsDir } = {}) {
  try {
    const dir = logsDir || join(process.cwd(), "logs");
    await mkdir(dir, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const entry = JSON.stringify({
      t: new Date().toISOString(),
      event: "guard_hit",
      type,
      action,
      reason: reason || undefined,
      guides: guides || undefined,
    }) + "\n";
    await appendFile(join(dir, `${date}.ndjson`), entry, "utf-8");
  } catch (e) {
    process.stderr.write(`[observability] guard_hit 日志写入失败: ${e?.message || e}\n`);
  }
}
