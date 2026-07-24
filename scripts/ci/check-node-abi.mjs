#!/usr/bin/env node
// scripts/ci/check-node-abi.mjs
// npm preinstall 钩子 —— 在 npm install 前检查 Node ABI 是否兼容 better-sqlite3。
// better-sqlite3 原生模块依赖 Node ABI 版本，Node 22 = ABI 127，Node 25 = ABI 141。
// 若 ABI 不匹配，安装的 .node 二进制无法加载，导致运行时崩溃。
// 本脚本在 ABI 不匹配时以非零退出码阻断 npm install，防止意外污染 node_modules。

const REQUIRED_ABI = 127;
const currentABI = Number(process.versions.modules);

// 跳过检查的场景
if (process.env.CI || process.env.CI_SKIP_ABI_CHECK) {
  process.exit(0);
}

if (currentABI === REQUIRED_ABI) {
  // ABI 匹配，放行
  process.exit(0);
}

// ABI 不匹配：阻断安装，给出清晰指引
console.error("");
console.error("╔══════════════════════════════════════════════════════════╗");
console.error("║  ❌ Node ABI 不兼容 — better-sqlite3 构建将失败        ║");
console.error("╠══════════════════════════════════════════════════════════╣");
console.error(`║  当前 Node: ${process.version.padEnd(25)} ABI: ${currentABI}`);
console.error(`║  需    求: ABI ${REQUIRED_ABI} (Node 22.x)              `);
console.error("║                                                        ║");
console.error("║  请使用 Node 22.22.2 运行 npm install：                ║");
console.error("║    nvm use 22.22.2                                      ║");
console.error("║    或                                                    ║");
console.error(`║    ${process.argv[1].replace(/check-node-abi.*$/, '')}node22/node install`);
console.error("║                                                        ║");
console.error("║  跳过检查（不推荐）：CI_SKIP_ABI_CHECK=1 npm install    ║");
console.error("╚══════════════════════════════════════════════════════════╝");
console.error("");

process.exit(1);
