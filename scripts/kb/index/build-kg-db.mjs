// scripts/kb/build-kg-db.mjs
// 从 .knowledge-graph.json 构建图谱 SQLite（二分图 + 递归 CTE 多跳索引）。
// 零新增依赖：复用 better-sqlite3（随 pi-knowledge 安装）。
//
// 用法:
//   node scripts/kb/build-kg-db.mjs            # 增量（JSON 未变则跳过）
//   node scripts/kb/build-kg-db.mjs --force    # 强制重建
//   node scripts/kb/build-kg-db.mjs --check    # 仅检查 DB 是否存在/新鲜

import { existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

const force = process.argv.includes("--force");
const check = process.argv.includes("--check");

async function main() {
  const { ensureGraphDb, graphDbPath, graphJsonPath } = await import(
    pathToFileURL(join(ROOT, ".pi", "extensions", "lib", "kg-graph-db.mjs")).href
  );

  const jsonPath = graphJsonPath(ROOT);
  const dbPath = graphDbPath(ROOT);

  if (check) {
    if (!existsSync(dbPath)) {
      console.log(`图谱 DB 不存在: ${dbPath}\n请运行: node scripts/kb/build-kg-db.mjs`);
      process.exit(1);
    }
    if (existsSync(jsonPath) && statSync(dbPath).mtimeMs < statSync(jsonPath).mtimeMs) {
      console.log(`图谱 DB 陈旧（JSON 已更新），需重建: node scripts/kb/build-kg-db.mjs`);
      process.exit(2);
    }
    console.log(`图谱 DB 新鲜: ${dbPath}`);
    process.exit(0);
  }

  console.log(`构建图谱 SQLite ...`);
  console.log(`  源: ${jsonPath}`);
  console.log(`  目标: ${dbPath}`);
  const r = ensureGraphDb({ jsonPath, dbPath, force });
  if (r.skipped) {
    console.log(`✅ 已是最新，跳过重建（${r.edges} 条边）`);
  } else {
    console.log(`✅ 构建完成：${r.entities} 实体 / ${r.edges} 条边`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error("构建失败:", err.message);
  process.exit(1);
});
