// lib/diagnostic-log.mjs
// 统一的『诊断日志出口』——所有非致命诊断（降级/回退/索引加载失败/探针抖动/埋点/
// 解析失败/遥测等）一律落 logs/diagnostics-YYYY-MM-DD.ndjson，绝不直写 stdout/stderr，
// 以免冲刷交互式 TUI（Pi 进程的 stdout/stderr 会直接污染终端 UI）。
//
// 分类铁律（调用点务必遵守）：
//   · 甲类（例程诊断）：本模块承接 —— 只落盘，不触终端。
//   · 乙类（日志子系统自身失败的最后告警，如『埋点落盘失败』『auditLog 写入失败』）：
//     极罕见，沿用 auditLog 既有约定保留 process.stderr.write（与 phi-crypto/observability
//     自身失败告警同例），不在此收口——因为这是「告警通道本身坏了」才会触发的信号。
//
// 与 auditLog 同源：LOGS_DIR = process.cwd()/logs（已 gitignore）。
// 双可测：纯 .mjs，供 .ts 扩展（jiti）与原生 node 单测共用。

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const LOGS_DIR = join(process.cwd(), "logs");

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
    appendFileSync(join(LOGS_DIR, `diagnostics-${date}.ndjson`), entry, "utf-8");
  } catch (err) {
    if (!_sinkBrokenWarned) {
      _sinkBrokenWarned = true;
      process.stderr.write(
        `[diagnostics] 日志落盘失败，后续诊断将静默丢弃: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }
}

/** 信息级诊断（如引擎版本探测）。 */
export function diagInfo(scope, message, meta) {
  emit("info", scope, message, meta);
}
/** 告警级诊断（降级/回退/解析失败/探针抖动）。 */
export function diagWarn(scope, message, meta) {
  emit("warn", scope, message, meta);
}
/** 错误级诊断（索引加载失败/注入失败等，仍非致命，不阻断主流程）。 */
export function diagError(scope, message, meta) {
  emit("error", scope, message, meta);
}

/** 便捷对象：diag.info / diag.warn / diag.error。 */
export const diag = {
  info: diagInfo,
  warn: diagWarn,
  error: diagError,
};

export default diag;
