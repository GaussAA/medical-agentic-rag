// kb-remove.mjs
// 知识库安全删除 + 回收站管理 CLI。
//
// 命令：
//   remove <sourceId>          将指定来源移入回收站（从 registry 移除 + 文件移入 _discarded/）
//   recycle list                 列出回收站内容
//   recycle restore <id>        从回收站恢复指定条目
//   recycle stats               回收站统计信息
//   recycle purge               清理过期条目（超 30 天自动删除文件）
//   recycle empty               清空回收站（物理删除，不可恢复）
//
// 用法：node scripts/kb/lifecycle/kb-remove.mjs <command> [args]
//
// 注意：
// - remove 仅删除 registry 登记 + 移动原始文件，索引重建需另行执行（kb:rebuild）
// - 建议配合 npm run kb:rebuild 或 knowledge_update 管线使用

import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-recycle.mjs")).href;
const REBUILD_SCRIPT = pathToFileURL(join(ROOT, "scripts/kb/ingest/rebuild-kb.mjs")).href;

const recycle = await import(MOD);

const [cmd, arg1] = process.argv.slice(2);

function fmtDate(s) {
  if (!s) return "-";
  const d = new Date(s);
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function fmtAge(removedAt) {
  const days = Math.round((Date.now() - new Date(removedAt).getTime()) / (24 * 60 * 60 * 1000));
  if (days === 0) return "今天";
  if (days === 1) return "1 天前";
  return `${days} 天前`;
}

// ------ 辅助：调用 rebuild-kb.mjs 触发 knowledge_update ------
async function triggerRebuild() {
  console.log("\n--- 触发知识库索引重建 ---");
  try {
    // 直接用子进程调 rebuild-kb（增量模式），与 kb:rebuild 一致
    const { spawn } = await import("node:child_process");
    const nodeBin = process.execPath;
    await new Promise((resolve, reject) => {
      const child = spawn(nodeBin, [fileURLToPath(REBUILD_SCRIPT)], {
        cwd: ROOT,
        stdio: "inherit",
        env: { ...process.env },
      });
      child.on("exit", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`rebuild-kb 退出码 ${code}`));
      });
      child.on("error", reject);
    });
    console.log("知识库索引重建完成\n");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[warn] 索引重建未执行（非致命，可手动运行 npm run kb:rebuild）: ${msg}\n`);
  }
}

async function main() {
  switch (cmd) {
    // ===== remove <sourceId> =====
    case "remove": {
      if (!arg1) {
        console.error("用法: node kb-remove.mjs remove <sourceId>");
        console.error("提示: 先运行 kb-update.mjs list 查看所有 sourceId");
        process.exit(1);
      }
      const result = recycle.removeFromRegistry(arg1, { removedBy: "cli", reason: process.argv[4] || "" });
      if (!result.ok) {
        console.error(`✗ ${result.error}`);
        process.exit(1);
      }
      console.log(`✓ 已移入回收站: [${result.entry.sourceId}] ${result.entry.sourceName}`);
      if (result.entry.movedFiles.length > 0) {
        console.log(`  移动文件 ${result.entry.movedFiles.length} 个 → data/raw/_discarded/${arg1}/`);
        for (const f of result.entry.movedFiles) {
          console.log(`    ${f.type}: ${f.from} → ${f.to}`);
        }
      } else {
        console.log("  无关联文件（仅有 registry 登记）");
      }
      console.log(`  回收站 ID: ${result.entry.id}`);
      console.log(`  保留至: ${fmtDate(new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString())}`);

      // 自动触发增量索引重建，使 pi-knowledge 感知变化
      await triggerRebuild();
      break;
    }

    // ===== recycle list =====
    case "recycle": {
      const sub = arg1 || "list";
      switch (sub) {
        case "list": {
          const entries = recycle.listRecycle({ includeExpired: process.argv.includes("--all") });
          if (entries.length === 0) {
            console.log("回收站为空");
            break;
          }
          console.log(`回收站共 ${entries.length} 项:\n`);
          for (const e of entries) {
            const expired = (Date.now() - new Date(e.removedAt).getTime()) >= (30 * 24 * 60 * 60 * 1000);
            const mark = expired ? "⏳ 过期" : "   ";
            console.log(`  ${mark} [${e.id.slice(0, 8)}] ${e.sourceName}`);
            console.log(`      来源 ID: ${e.sourceId}`);
            console.log(`      删除时间: ${fmtDate(e.removedAt)} (${fmtAge(e.removedAt)})`);
            if (e.reason) console.log(`      原因: ${e.reason}`);
            if (e.movedFiles.length > 0) {
              console.log(`      文件: ${e.movedFiles.length} 个`);
            }
            console.log("");
          }
          break;
        }

        case "restore": {
          const restoreId = process.argv[4]; // recycle restore <id>
          if (!restoreId) {
            console.error("用法: node kb-remove.mjs recycle restore <recycleId>");
            console.error("提示: 先运行 recycle list 查看 ID");
            process.exit(1);
          }
          const result = recycle.restoreFromRecycle(restoreId);
          if (!result.ok) {
            console.error(`✗ ${result.error}`);
            process.exit(1);
          }
          console.log(`✓ 已恢复: [${result.entry.sourceId}] ${result.entry.sourceName}`);
          console.log(`  文件已移回原位`);
          // 自动触发增量索引重建
          await triggerRebuild();
          break;
        }

        case "stats": {
          const stats = recycle.getRecycleStats();
          console.log(`回收站统计:`);
          console.log(`  总条目: ${stats.total}`);
          console.log(`  已过期: ${stats.expiredCount}`);
          console.log(`  保留期限: ${stats.retentionDays} 天`);
          console.log(`  最早删除: ${stats.oldestRemoved ? fmtDate(stats.oldestRemoved) : "-"}`);
          break;
        }

        case "purge": {
          const result = recycle.purgeExpired();
          console.log(`已清理过期条目: ${result.purged} 项`);
          if (result.errors.length > 0) {
            for (const e of result.errors) console.warn(`  ⚠ ${e}`);
          }
          if (result.purged > 0) {
            console.log("建议运行 npm run kb:rebuild 同步索引变更");
          }
          break;
        }

        case "empty": {
          console.warn("⚠ 警告: 此操作将清空回收站，所有文件物理删除，不可恢复！");
          console.warn(`  当前条目: ${recycle.getRecycleStats().total} 项`);
          console.warn("  请确认? (y/N)");
          // 非交互模式默认不执行
          const confirm = process.argv.includes("--force") || process.argv.includes("-f");
          if (!confirm) {
            console.log("已取消。如需强制清空，添加 --force 参数");
            process.exit(0);
          }
          const result = recycle.emptyRecycle();
          console.log(`已清空回收站: ${result.purged} 项已物理删除`);
          if (result.errors.length > 0) {
            for (const e of result.errors) console.warn(`  ⚠ ${e}`);
          }
          break;
        }

        default:
          console.error(`未知子命令: "${sub}"`);
          console.log("可用子命令: list, restore <id>, stats, purge, empty");
          process.exit(1);
      }
      break;
    }

    default: {
      console.log(`知识库安全删除 CLI

用法: node scripts/kb/lifecycle/kb-remove.mjs <command> [args]

命令:
  remove <sourceId> [reason]    将指定来源移入回收站
  recycle list [--all]          列出回收站（--all 包含过期条目）
  recycle restore <recycleId>   从回收站恢复指定条目
  recycle stats                 回收站统计
  recycle purge                 清理过期条目（超 30 天删除文件）
  recycle empty [--force]       清空回收站（物理删除，不可恢复）

提示:
  - 先运行 kb-update.mjs list 查看所有 sourceId
  - remove 会自动触发索引增量重建
  - 恢复后也会自动触发索引重建`);
      process.exit(cmd ? 1 : 0);
    }
  }
}

main().catch((err) => {
  console.error("[kb-remove] 失败:", err);
  process.exit(1);
});
