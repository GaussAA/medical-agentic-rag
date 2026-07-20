/**
 * 会话手动归档扩展
 *
 * 提供 /archive 命令，将会话从活跃区移入归档目录。
 * 交互式选择器已抽取至 lib/session-picker.mjs，可复用于其他命令。
 *
 * 归档路径：.pi/archive/YYYY-MM/<session_id>.jsonl
 *
 * 用法：
 *   /archive          — 交互式搜索 + 选择要归档的会话
 *   /archive all      — 一键归档所有活跃会话
 *   /archive list     — 列出已归档的会话
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdir, stat, rename, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
// @ts-ignore —— .mjs 共享模块，由 jiti 加载
import { pickSession } from "./lib/session-picker.mjs";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("archive", {
    description:
      "将会话移入归档：archive（搜索+选择）| archive all（全部归档）| archive list（列出已归档）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const subCmd = parts[0]?.toLowerCase() || "";
      const sessionDir = ctx.sessionManager.getSessionDir();
      if (!sessionDir) {
        ctx.ui.notify("无法获取会话目录。", "error");
        return;
      }

      // ── archive list — 列出已归档会话 ─────────────────────
      if (subCmd === "list") {
        const archiveRoot = join(sessionDir, "..", "archive");
        if (!existsSync(archiveRoot)) {
          ctx.ui.notify("尚无归档会话。", "info");
          return;
        }
        const months = await readdir(archiveRoot);
        let total = 0;
        const lines: string[] = [];
        for (const m of months.sort()) {
          const monthDir = join(archiveRoot, m);
          const s = await stat(monthDir);
          if (!s.isDirectory()) continue;
          const files = (await readdir(monthDir)).filter((f) => f.endsWith(".jsonl"));
          if (files.length === 0) continue;
          total += files.length;
          lines.push(`  ${m}: ${files.length} 条`);
        }
        if (total === 0) {
          ctx.ui.notify("尚无归档会话。", "info");
          return;
        }
        ctx.ui.notify(`归档会话 (共 ${total} 条):\n${lines.join("\n")}\n\n归档目录: ${archiveRoot}`, "info");
        return;
      }

      // ── archive all — 一键归档全部 ────────────────────────
      if (subCmd === "all") {
        const files = await listSessionFiles(sessionDir);
        if (files.length === 0) {
          ctx.ui.notify("没有活跃会话可归档。", "info");
          return;
        }
        const confirmed = await ctx.ui.confirm(
          "归档全部",
          `确认将全部 ${files.length} 个活跃会话移入归档？此操作不可撤销。`,
        );
        if (!confirmed) {
          ctx.ui.notify("已取消。", "info");
          return;
        }
        let archived = 0;
        for (const f of files) {
          try { await archiveFile(f, sessionDir); archived++; }
          catch { /* 跳过失败项 */ }
        }
        ctx.ui.notify(`已归档 ${archived}/${files.length} 个会话 → .pi/archive/`, "info");
        return;
      }

      // ── archive — 交互式搜索 + 选择归档 ──────────────────
      const sessions = await listSessionSummaries(sessionDir);
      if (sessions.length === 0) {
        ctx.ui.notify("没有活跃会话可归档。", "info");
        return;
      }

      const { session: picked, all } = await pickSession(ctx, sessions, {
        title: "选择要归档的会话",
        showAllOption: true,
      });

      if (!picked && !all) return; // 用户取消

      if (all) {
        const confirmed = await ctx.ui.confirm(
          "归档全部",
          `确认将全部 ${sessions.length} 个活跃会话移入归档？`,
        );
        if (!confirmed) { ctx.ui.notify("已取消。", "info"); return; }
        let archived = 0;
        for (const s of sessions) {
          try { await archiveFile(s.path, sessionDir); archived++; }
          catch { /* 跳过 */ }
        }
        ctx.ui.notify(`已归档 ${archived}/${sessions.length} 个会话 → .pi/archive/`, "info");
        return;
      }

      try {
        await archiveFile(picked.path, sessionDir);
        ctx.ui.notify(
          `已归档会话 [${picked.id.slice(0, 8)}]` +
            (picked.name ? `「${picked.name}」` : ""),
          "info",
        );
      } catch (err: any) {
        ctx.ui.notify(`归档失败: ${err?.message || err}`, "error");
      }
    },
  });
}

// =============================================================================
// 辅助函数
// =============================================================================

interface SessionSummary {
  id: string; path: string; name?: string;
  mtime: Date; messageCount: number; firstMessage: string;
}

async function listSessionFiles(sessionDir: string): Promise<string[]> {
  try {
    return (await readdir(sessionDir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f));
  } catch { return []; }
}

async function listSessionSummaries(sessionDir: string): Promise<SessionSummary[]> {
  const files = await listSessionFiles(sessionDir);
  const result: SessionSummary[] = [];

  for (const filePath of files) {
    try {
      const s = await stat(filePath);
      if (!s.isFile()) continue;
      const content = readFileSync(filePath, "utf-8");
      const lines = content.trim().split("\n").filter(Boolean);
      if (lines.length === 0) continue;

      let header: any;
      try { header = JSON.parse(lines[0]); } catch { continue; }
      if (header.type !== "session" || !header.id) continue;

      let name: string | undefined, firstMsg = "", msgCount = 0;
      for (let i = 1; i < lines.length; i++) {
        try {
          const entry = JSON.parse(lines[i]);
          if (entry.type === "session_info" && entry.name) name = entry.name;
          if (entry.type === "message" && entry.message?.role &&
              (entry.message.role === "user" || entry.message.role === "assistant")) {
            msgCount++;
            if (!firstMsg && entry.message.role === "user") {
              const c = entry.message.content;
              firstMsg = Array.isArray(c)
                ? c.map((p: any) => p.text || "").join(" ")
                : typeof c === "string" ? c : "";
            }
          }
        } catch { /* 跳过损坏行 */ }
      }

      result.push({ id: header.id, path: filePath, name, mtime: s.mtime, messageCount: msgCount, firstMessage: firstMsg });
    } catch { /* 跳过损坏文件 */ }
  }

  result.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  return result;
}

async function archiveFile(filePath: string, sessionDir: string): Promise<void> {
  const s = await stat(filePath);
  const monthDir = join(sessionDir, "..", "archive", s.mtime.toISOString().slice(0, 7));
  await mkdir(monthDir, { recursive: true });
  await rename(filePath, join(monthDir, filePath.split(/[/\\]/).pop()!));
}
