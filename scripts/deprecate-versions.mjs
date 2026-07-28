#!/usr/bin/env node
// DEPRECATED — 此路径已迁移，请使用 scripts/kb/lifecycle/deprecate-versions.mjs
// 本文件为旧自动化兼容转发，执行实际脚本
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
const __dirname = dirname(fileURLToPath(import.meta.url));
const r = spawnSync(process.execPath, [join(__dirname, "kb", "lifecycle", "deprecate-versions.mjs"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
process.exit(r.status ?? 1);
