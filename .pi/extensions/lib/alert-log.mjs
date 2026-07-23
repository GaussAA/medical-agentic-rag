// lib/alert-log.mjs
// 独立的『乙类告警出口』——承接各子系统「自身写失败」的最后告警
// （如『埋点落盘失败』『audit 写入失败』『PHI 加密失败』等）。
//
// 与设计原则：
//   · 此前此类告警直写 process.stderr，会冲刷交互式 TUI（Pi 进程的 stderr 直接污染终端 UI）。
//   · 现统一收口至 logs/alerts-YYYY-MM-DD.ndjson，使「诊断尽归日志、终端纤尘不染」彻底闭环。
//   · 与 diagnostic-log.mjs 相互独立（互不 import），确保任一 sink 挂掉仍有兜底可见：
//     若本 sink 自身落盘失败，仅进程内 throttled 告警一次到 stderr（终极 meta 告警，不刷屏）。
//
// 与 diagnostic-log 同源：LOGS_DIR = process.cwd()/logs（已 gitignore）。
// 双可测：纯 .mjs，供 .ts 扩展（jiti）与原生 node 单测共用。

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOGS_DIR = join(process.cwd(), ".pi/logs");

// 落盘自身失败极罕见；仅进程内告警一次，不向终端刷屏（避免噪声复现）
let _sinkBrokenWarned = false;

function emit(level, scope, message, meta) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const entry =
      JSON.stringify({
        t: new Date().toISOString(),
        level,
        scope,
        message,
        ...(meta && Object.keys(meta).length ? meta : {}),
      }) + "\n";
    appendFileSync(join(LOGS_DIR, `alerts-${date}.ndjson`), entry, "utf-8");
  } catch (err) {
    if (!_sinkBrokenWarned) {
      _sinkBrokenWarned = true;
      process.stderr.write(
        `[alerts] 告警落盘失败，后续乙类告警将静默丢弃: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/**
 * 乙类告警（子系统自身写失败/严重异常的最后信号，非致命但须留痕）。
 * @param {string} scope 触发告警的模块/子系统名
 * @param {string} message 告警内容
 * @param {object} [meta] 附加结构化字段
 */
export function alert(scope, message, meta) {
  emit("alert", scope, message, meta);
}

/** 便捷对象：alert.emit(scope, message, meta)。 */
export const alertLog = {
  emit: alert,
};

export default alert;
