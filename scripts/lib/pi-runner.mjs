// scripts/lib/pi-runner.mjs
// 统一 Pi 进程驱动内核（P0-5 / P1-4 修复：抽离 findPiRuntime / killTree 公共实现，
// 消除 scripts/ 下三~四处复制，并使「跨平台进程树诛杀」成为唯一真相源）。
//
// 依赖：config.mjs（项目根 / Node / Pi 运行时定位，均由 env / homedir 推导，跨机安全）。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { findPiRuntime as _findPiRuntime, toNativePath } from "./config.mjs";

export { toNativePath };

// 重导出，便于调用方一处 import 即可拿到运行时定位。
export function findPiRuntime() {
  return _findPiRuntime();
}

// ---------- 项目根 / 代理 preload 路径（跨机安全，相对路径推导） ----------
const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // lib -> scripts -> repoRoot
const PRELOAD_PATH = join(ROOT, "scripts", "proxy", "preload-fetch-proxy.mjs");

// ---------- ANSI 转义清洗（Pi 非交互输出常带终端色码） ----------
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
export function stripAnsi(s) {
  return String(s || "").replace(ANSI_RE, "");
}

// ---------- 统一 Pi 非交互驱动 ----------
/**
 * 驱动 Pi Agent 非交互作答（spawn cli print 模式）。
 * 收敛 collect-agent-answers / generate-ab-input / agent-driver 三份重复实现为单一真相源。
 * 超时或异常统一 reject（与既有两处 runPi 行为一致）；agent-driver 经 try/catch 转 resolve。
 *
 * @param {string[]} argsArray 传给 cli 的参数（如 ["--print", msg, "--model", ...]）
 * @param {object} [opts]
 *   - timeoutMs  单条超时(ms)，默认 420000（慢速免费通道冷启动偏紧，可调高）
 *   - proxy      true：注入 --require PRELOAD_PATH 并经 NODE_PATH 暴露 pi/node_modules
 *                （即 collect-agent-answers 的 proxy 路由范式；ab-input 等无需代理时 false）
 *   - nodeBin   可选：覆盖运行时 node（agent-driver 用固定 NODE_BIN）
 *   - cliPath   可选：覆盖 cli 路径（agent-driver 用 CLI_PATH）
 *   - killOnClose  关闭时诛整棵子树（防孤儿 Pi 持 KB 锁），默认 true（对齐 P0-5 意图）
 *   - cwd       默认 ROOT
 *   - detached  非 Windows 时使 Pi 成进程组组长，kill(-pid) 可诛整树，默认 true
 * @returns {Promise<{answer:string, stderr:string, code:number|null, timedOut:boolean}>}
 */
export function runPi(argsArray, opts = {}) {
  const {
    timeoutMs = 420000,
    proxy = false,
    killOnClose = true,
    cwd = ROOT,
    detached = process.platform !== "win32",
    nodeBin,
    cliPath,
  } = opts;
  const rt = findPiRuntime();
  const cmd = nodeBin || (rt ? rt.node : "pi");
  const cli = cliPath || (rt ? rt.cli : null);
  return new Promise((resolve, reject) => {
    const spawnOpts = {
      env: {
        ...process.env,
        ...(proxy ? { NODE_PATH: join(ROOT, "pi", "node_modules") } : {}),
        ...(nodeBin ? { NODE_BIN: nodeBin } : {}),
      },
      cwd,
      windowsHide: true,
      shell: false,
      detached,
      stdio: ["ignore", "pipe", "pipe"],
    };
    const nodeArgs = [];
    if (cli && proxy) nodeArgs.push("--require", PRELOAD_PATH);
    if (cli) nodeArgs.push(cli);
    nodeArgs.push(...argsArray);
    const child = spawn(cmd, nodeArgs, spawnOpts);
    let stdout = "";
    let stderr = "";
    let settled = false;
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try { killTree(child.pid); } catch {}
      if (!settled) {
        settled = true;
        reject(new Error(`timeout ${timeoutMs}ms`));
      }
    }, timeoutMs);
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on("close", (code) => {
      if (killOnClose) { try { killTree(child.pid); } catch {} }
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ answer: stripAnsi(stdout).trim(), stderr, code, timedOut: false });
      }
    });
  });
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
