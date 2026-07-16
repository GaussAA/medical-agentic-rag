// scripts/lib/pi-runner.mjs
// 统一 Pi 进程驱动内核（P0-5 / P1-4 修复：抽离 findPiRuntime / killTree 公共实现，
// 消除 scripts/ 下三~四处复制，并使「跨平台进程树诛杀」成为唯一真相源）。
//
// 依赖：config.mjs（项目根 / Node / Pi 运行时定位，均由 env / homedir 推导，跨机安全）。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { findPiRuntime as _findPiRuntime, toNativePath } from "./config.mjs";

export { toNativePath };

// 重导出，便于调用方一处 import 即可拿到运行时定位。
export function findPiRuntime() {
  return _findPiRuntime();
}

// ---------- 跨平台进程树诛杀 ----------
// 根治「孤儿 Pi 持全局 KB 写锁饿死新实例」的运营故障。
//   Windows: taskkill /T /F 强杀整棵子树。
//   非 Windows: 向进程组发 SIGTERM（宽限）→ SIGKILL（兜底），
//     要求子进程以 detached 启动成为进程组组长（见各 runPi 的 detached 设置）。
//   catch 静默：进程已退出则忽略，绝不抛。
const TREE_KILL_GRACE_MS = Number(process.env.TREE_KILL_GRACE_MS) || 400;
export function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      return;
    }
    // 非 Windows：先 SIGTERM 给进程组一点退出时间，再 SIGKILL 兜底。
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* 进程组已不存在 */
    }
    setTimeout(() => {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        /* noop */
      }
    }, TREE_KILL_GRACE_MS);
  } catch {
    /* 顶层异常（如 pid 非法）忽略 */
  }
}
