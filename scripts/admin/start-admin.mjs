// scripts/admin/start-admin.mjs
// 知识库管理面板启动器 —— 自动选择受管 Node 22.22.2（ABI127）
// 解决 npm run admin:kb 默认使用系统 Node v25（ABI141）导致
// better-sqlite3 native 模块 ABI 不兼容的问题。

import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { managedNode22 } from "../lib/config.mjs";

const SCRIPT = join(import.meta.dirname, "kb-admin-server.mjs");

// 设置 PI_KNOWLEDGE_DIR（如果未设置）
if (!process.env.PI_KNOWLEDGE_DIR) {
  process.env.PI_KNOWLEDGE_DIR = join(process.cwd(), ".pi", "knowledge");
}

const nodeBin = managedNode22();
const altNode = process.env.PI_NODE_BIN; // 手动覆盖

const finalNode = altNode || nodeBin;

console.log(`[admin] Node: ${finalNode}`);
console.log(`[admin] KB:   ${process.env.PI_KNOWLEDGE_DIR}/knowledge.db`);

const result = spawnSync(finalNode, [SCRIPT], {
  stdio: "inherit",
  env: { ...process.env },
  cwd: process.cwd(),
});

process.exit(result.status ?? 1);
