// scripts/lib/config.mjs
// 集中解析项目根 / 受控 Node 二进制 / Pi npm 根 / better-sqlite3 候选 / Pi 运行时定位。
//
// 设计纪律（消除跨机绑定，P0-1 修复核心）：
//   · 所有路径均由 process.env 或 os.homedir() 推导，杜绝写死用户名
//     （旧码 C:/Users/JaNiy/...、/e/nvm4w/... 等仅作兜底候选，且由 homedir 推导）。
//   · 优先环境变量（NODE_BIN / PI_NODE / PI_CLI / PI_AGENT_NPM），其次 homedir 推导的受控路径，
//     最后退回通用 "node" / "pi"（优雅降级，不致 ENOENT）。
//   · 纯 ESM、零副作用，供 scripts/ 下各 CLI 与 .mjs 单测直接 import。
import os from "node:os";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url)); // scripts/lib

// ---------- 稳健解析项目根 ----------
// 从本文件目录向上递归找含 package.json 的目录（不写死 ../ 层数，防文件迁移越界）。
export function findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // 已到盘符根
    dir = parent;
  }
  return startDir; // 兜底
}
export const ROOT = findProjectRoot(__dirname);

// ---------- 路径规整 ----------
// 把 /c/Users/... 这类 Git-Bash 路径转为 C:/Users/...（仅 Windows）。
export function toNativePath(p) {
  if (!p) return p;
  if (process.platform === "win32" && /^\/[a-zA-Z]\//.test(p)) {
    return p.replace(/^\/([a-zA-Z])\//, "$1:/");
  }
  return p;
}

// ---------- 受控 Node 二进制 ----------
// 优先级：NODE_BIN / PI_NODE env → homedir 推导的受控 node22(ABI127) → 通用 "node"。
export function resolveNodeBin() {
  const fromEnv = process.env.NODE_BIN
    ? toNativePath(process.env.NODE_BIN)
    : process.env.PI_NODE
      ? toNativePath(process.env.PI_NODE)
      : "";
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const managed = managedNode22();
  if (managed && existsSync(managed)) return managed;
  return "node"; // 优雅降级（ABI 风险由调用方日志告警）
}

// 受控 node22（ABI127）：经 os.homedir() 推导，不写死用户名。
export function managedNode22() {
  const home = os.homedir();
  if (!home) return "";
  const verRoot = join(home, ".workbuddy", "binaries", "node", "versions");
  if (!existsSync(verRoot)) return "";
  // 跨机版本号可能微调，按 22.x 前缀取最新
  try {
    const v22 = require_fs_readdir(verRoot).filter((d) => d.startsWith("22.")).sort().pop();
    if (v22) {
      const p = join(verRoot, v22, process.platform === "win32" ? "node.exe" : "bin/node");
      if (existsSync(p)) return p;
    }
  } catch {
    /* 读目录失败则忽略 */
  }
  return "";
}

// 轻量 readdir 包装（避免顶部引入 fs 全部符号）
import { readdirSync } from "node:fs";
function require_fs_readdir(dir) {
  return readdirSync(dir);
}

// ---------- Pi npm 根 ----------
export function piAgentNpmRoot() {
  if (process.env.PI_AGENT_NPM) return process.env.PI_AGENT_NPM;
  const home = os.homedir();
  return home ? join(home, ".pi", "agent", "npm") : "";
}

// ---------- better-sqlite3 动态加载候选 ----------
// 与 retrieval-router / chunk-quality 同范式：优先 env，其次 homedir 推导，绝不写死用户名。
export function betterSqlite3Candidates() {
  const npmRoot = piAgentNpmRoot();
  return [
    "better-sqlite3",
    process.env.PI_AGENT_NPM ? join(process.env.PI_AGENT_NPM, "node_modules", "better-sqlite3") : null,
    npmRoot ? join(npmRoot, "node_modules", "better-sqlite3") : null,
  ].filter(Boolean);
}

// ---------- Pi cli.js 候选路径 ----------
function piCliCandidates() {
  const REL = ["node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js"];
  const bases = [];
  if (process.env.PI_CLI) bases.push(process.env.PI_CLI);
  // 常见安装位（仅作兜底探测，不再写死 /e/nvm4w 等盘符路径）
  const home = os.homedir();
  if (home) {
    bases.push(join(home, ".nvm4w", "nodejs")); // nvm4w 默认位（Windows）
  }
  bases.push(join(ROOT, "pi", "node_modules")); // 仓内 vendor
  const out = [];
  for (const b of bases) out.push(join(b, ...REL));
  return out.filter((p) => existsSync(p));
}

// ---------- 统一 Pi 运行时定位 ----------
// 返回 { node, cli } 或 null（均跨机安全：node 走 resolveNodeBin，cli 走候选探测）。
export function findPiRuntime() {
  const node = resolveNodeBin();
  const cli = piCliCandidates()[0];
  if (!cli) return null;
  return { node, cli };
}
