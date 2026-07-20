// scripts/ops/lib/agent-driver.mjs
// 真实 Agent 多轮驱动（共享内核）——B0-b 真链路 / B3 多轮评测 harness 共用。
//
// 设计纪律（契合项目原则，与 scripts/ops/smoke-real-link.mjs 同源）：
//   · 零静默失败：任何异常显式捕获、结构化日志；运行期故障绝不吞没。
//   · 优雅跳过：本环境若无外联（proxy 探活失败 / failover 降级），一律 exit 2 跳过，
//     绝不误报/飘红——真链路多轮属「本地开发机 / 自托管 nightly runner」任务。
//   · 复用 start.sh 既有启动范式：managed node + --require preload + cli.js + --model + --system-prompt
//     + --session-dir + --print（非交互 print 模式）+ --no-approve（避免工具审批挂起）
//     + 第 2 轮起 --resume（续会话上下文）。
//
// 退出码（与 pre-push / nightly 约定一致）：
//   0 = 通过（真实多轮链路健康，澄清硬上限在真 LLM 层亦生效）
//   1 = 真实链路故障（澄清计数越界 / 驱动异常）
//   2 = 跳过（本环境无外联 / 无真库，nightly 宿主机优雅跳过，不阻塞）
//
// 运行：被 clarification-real-link.mjs / eval-bench-multiturn.mjs 复用，不直接跑。

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { runPi } from "../../lib/pi-runner.mjs"; // P0-5/P1#4 修复：统一 Pi 驱动内核（跨平台树杀）

const HERE = dirname(fileURLToPath(import.meta.url)); // scripts/ops/lib
const ROOT = join(HERE, "..", "..", ".."); // lib -> ops -> scripts -> repoRoot
const CLI_PATH = join(ROOT, "pi", "packages", "coding-agent", "dist", "cli.js");
const PROXY = join(ROOT, "scripts", "proxy", "provider-proxy.mjs");
const FAILOVER = join(ROOT, "scripts", "proxy", "launch-with-failover.mjs");
const PROMPT = join(ROOT, ".pi", "prompts", "medical-agent.md");
const PROXY_PORT = process.env.PROXY_PORT || "18880";
const NODE_BIN = process.env.NODE_BIN || process.execPath;
const TURN_TIMEOUT_MS = Number(process.env.TURN_TIMEOUT_MS || 180000);

/** 健康探活：proxy 是否已在 127.0.0.1:PROXY_PORT 监听。 */
async function proxyUp() {
  try {
    const res = await fetch(`http://127.0.0.1:${PROXY_PORT}/health`);
    return res.ok;
  } catch {
    return false;
  }
}

/** 启动 provider-proxy（后台），等待就绪；已起则跳过。返回是否 UP。 */
async function ensureProxy() {
  if (await proxyUp()) return true;
  try {
    mkdirSync(join(ROOT, ".pi", "logs"), { recursive: true });
    const log = join(ROOT, ".pi", "logs", "proxy.log");
    const child = spawn(
      NODE_BIN,
      [PROXY, `--port=${PROXY_PORT}`],
      { cwd: ROOT, env: process.env, stdio: ["ignore", await fileHandle(log), "pipe"] },
    );
    child.on("error", () => {}); // 不影响主流程，下方探活会兜底
    for (let i = 0; i < 30; i++) {
      await sleep(1000);
      if (await proxyUp()) return true;
    }
    return false;
  } catch {
    return false;
  }
}

/** 运行 failover 选健，读 .pi/failover-selection.json。 */
async function selectProvider() {
  try {
    await spawnAsync(
      NODE_BIN,
      [FAILOVER],
      { cwd: ROOT, env: process.env, stdio: ["ignore", "ignore", "ignore"] },
      30000,
    );
  } catch {
    /* 选健失败不阻断，下方读文件兜底 */
  }
  const selPath = join(ROOT, ".pi", "failover-selection.json");
  if (!existsSync(selPath)) return null;
  try {
    return JSON.parse(readFileSync(selPath, "utf-8"));
  } catch {
    return null;
  }
}

/** 能力闸门：proxy + failover 双探。无外联则 false（驱动应 exit 2 跳过）。 */
export async function canRunRealLink() {
  const up = await ensureProxy();
  if (!up) return { ok: false, reason: "proxy_down" };
  const sel = await selectProvider();
  if (!sel || !sel.provider || !sel.model) {
    return { ok: false, reason: "no_provider_selected" };
  }
  if (sel.degraded) {
    return { ok: false, reason: `provider_degraded:${sel.reason || "unknown"}` };
  }
  return { ok: true, provider: sel.provider, model: sel.model };
}

/** 单轮驱动：spawn cli print 模式处理一条用户消息。Pi 驱动内核统一至 pi-runner.runPi。 */
async function runTurn(msg, { provider, model, sessionDir, turnIndex }) {
  const args = [
    "--print", msg,
    "--model", `${provider}/${model}`,
    "--system-prompt", PROMPT,
    "--session-dir", sessionDir,
    "--no-approve",
  ];
  if (turnIndex > 0) args.push("--resume");
  try {
    // nodeBin/cliPath 沿用本模块固定 NODE_BIN / CLI_PATH（与既有真链路启动范式一致）；
    // proxy:true 注入 --require PRELOAD + NODE_PATH=pi/node_modules，关毕默认诛整棵子树。
    const r = await runPi(args, { nodeBin: NODE_BIN, cliPath: CLI_PATH, proxy: true, timeoutMs: TURN_TIMEOUT_MS });
    return { code: r.code, timedOut: r.timedOut };
  } catch (e) {
    return { code: null, timedOut: false, error: String(e?.message || e) };
  }
}

/** 读数：.pi/conversation-state.json 的 clarificationCount（缺则 0）。 */
export function readClarificationCount() {
  const p = join(ROOT, ".pi", "conversation-state.json");
  if (!existsSync(p)) return 0;
  try {
    const st = JSON.parse(readFileSync(p, "utf-8"));
    return typeof st.clarificationCount === "number" ? st.clarificationCount : 0;
  } catch {
    return 0;
  }
}

/**
 * 多轮场景驱动：逐轮 spawn cli，续会话，返回每轮后澄清计数与末轮计数。
 * @param {string[]} turns  用户每轮消息
 * @param {{provider:string, model:string}} sel
 * @returns {Promise<{turns:Array<{idx:number,count:number,code:number,timedOut:boolean}>, finalCount:number}>}
 */
export async function runScenario(turns, sel) {
  const sessionDir = join(ROOT, ".pi", "sessions", `real-link-${Date.now()}`);
  mkdirSync(sessionDir, { recursive: true });
  const trace = [];
  for (let i = 0; i < turns.length; i++) {
    const r = await runTurn(turns[i], { ...sel, sessionDir, turnIndex: i });
    trace.push({ idx: i + 1, count: readClarificationCount(), code: r.code, timedOut: r.timedOut });
  }
  return { turns: trace, finalCount: readClarificationCount() };
}

// ---- 内部：spawn 封装（超时熔断 + stdout/stderr 收集）----
async function spawnAsync(cmd, args, opts, timeoutMs) {
  return new Promise((resolve) => {
    let out = "";
    let err = "";
    let settled = false;
    const child = spawn(cmd, args, opts);
    child.stdout?.on("data", (d) => (out += d.toString()));
    child.stderr?.on("data", (d) => (err += d.toString()));
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        try { child.kill("SIGKILL"); } catch {}
        resolve({ code: null, timedOut: true, stdout: out, stderr: err });
      }
    }, timeoutMs);
    child.on("error", (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: null, timedOut: false, error: String(e?.message || e), stdout: out, stderr: err });
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code, timedOut: false, stdout: out, stderr: err });
      }
    });
  });
}

// file handle helper（避免 import fs/promises 重复）
async function fileHandle(p) {
  const { open } = await import("node:fs/promises");
  return open(p, "a").then((h) => h.fd).catch(() => "ignore");
}
