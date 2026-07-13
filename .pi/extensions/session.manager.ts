/**
 * 会话管理扩展
 *
 * 提供 /sessions 命令体系，支持在对话中列出、切换、导出历史会话。
 * 配合 start.sh 的 --session-dir .pi/sessions 使用，会话历史存于项目本地。
 *
 * 命令:
 *   /sessions list              — 列出所有历史会话（ID/时间/消息数/首条内容）
 *   /sessions switch <id|序号>  — 切换到指定会话
 *   /sessions export <id|序号>  — 导出会话为 JSON 文件（.pi/sessions/export-<id>.json）
 *   /sessions info              — 显示当前会话信息
 */
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { readdirSync, readFileSync, statSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join, basename } from "path";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("sessions", {
    description:
      "会话管理：sessions list（列出历史会话）| sessions switch <id|序号>（切换会话）| sessions export <id|序号>（导出会话）| sessions info（当前会话信息）",
    handler: async (args: string, ctx: ExtensionCommandContext) => {
      const parts = args.trim().split(/\s+/);
      const subCmd = parts[0]?.toLowerCase() || "list";
      const dir = ctx.sessionManager.getSessionDir();
      const cwd = ctx.cwd;

      switch (subCmd) {
        // ============================================
        // /sessions list — 列出历史会话
        // ============================================
        case "list": {
          const sessions = listSessions(dir);
          if (sessions.length === 0) {
            ctx.ui.notify("暂无历史会话，当前会话会在退出后归档至此目录。", "info");
            return;
          }

          const display = sessions.length > 20 ? sessions.slice(0, 20) : sessions;
          const header =
            display.length < sessions.length
              ? `历史会话 (共 ${sessions.length} 条，显示前 20 条):\n`
              : `历史会话 (共 ${sessions.length} 条):\n`;
          const lines = display.map((s, i) => {
            const time = s.created.toLocaleString("zh-CN");
            const name = s.name ? ` 「${s.name}」` : "";
            const first = s.firstMessage ? ` ${s.firstMessage.slice(0, 40)}` : "";
            return `  ${i + 1}. [${s.id.slice(0, 8)}] ${time}${name} — ${s.messageCount} 条${first}`;
          });
          ctx.ui.notify(header + lines.join("\n"), "info");
          return;
        }

        // ============================================
        // /sessions switch <id|序号> — 切换会话
        // ============================================
        case "switch": {
          const target = parts[1];
          if (!target) {
            ctx.ui.notify("请指定会话 ID 或序号。用法: sessions switch <id|序号>", "warning");
            return;
          }

          const sessions = listSessions(dir);
          const matched = resolveSession(sessions, target);
          if (!matched) {
            ctx.ui.notify(`未找到匹配「${target}」的会话。`, "warning");
            return;
          }

          ctx.ui.notify(`正在切换到会话 ${matched.id.slice(0, 8)}...`, "info");
          await ctx.switchSession(matched.path);
          return;
        }

        // ============================================
        // /sessions export <id|序号> — 导出会话
        // ============================================
        case "export": {
          const target = parts[1];
          if (!target) {
            ctx.ui.notify("请指定会话 ID 或序号。用法: sessions export <id|序号>", "warning");
            return;
          }

          const sessions = listSessions(dir);
          const matched = resolveSession(sessions, target);
          if (!matched) {
            ctx.ui.notify(`未找到匹配「${target}」的会话。`, "warning");
            return;
          }

          const content = readFileSync(matched.path, "utf-8");
          const lines = content.trim().split("\n").filter(Boolean);
          const entries = lines.map((l) => JSON.parse(l));

          if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
          }
          const exportName = `export-${matched.id.slice(0, 8)}.json`;
          const exportPath = join(dir, exportName);
          writeFileSync(exportPath, JSON.stringify(entries, null, 2), "utf-8");

          ctx.ui.notify(`已导出 ${entries.length} 条条目至 ${exportPath}`, "info");
          return;
        }

        // ============================================
        // /sessions info — 当前会话信息
        // ============================================
        case "info": {
          const sm = ctx.sessionManager;
          const id = sm.getSessionId();
          const name = sm.getSessionName() || "(未命名)";
          const file = sm.getSessionFile() || "(内存)";
          const entries = sm.getEntries();
          const leafId = sm.getLeafId();
          ctx.ui.notify(
            `当前会话:\n` +
              `  ID:   ${id}\n` +
              `  名称: ${name}\n` +
              `  文件: ${file}\n` +
              `  消息: ${entries.length} 条\n` +
              `  分支: ${leafId ? leafId.slice(0, 8) : "无"}`,
            "info",
          );
          return;
        }

        // ============================================
        // 默认：显示用法
        // ============================================
        default: {
          ctx.ui.notify(
            "用法:\n" +
              `  sessions list                     — 列出历史会话\n` +
              `  sessions switch <id|序号>         — 切换到指定会话\n` +
              `  sessions export <id|序号>         — 导出会话为 JSON\n` +
              `  sessions info                     — 显示当前会话信息`,
            "warning",
          );
        }
      }
    },
  });
}

// =============================================================================
// 本地实现：不依赖 SessionManager 运行时导入，直接读取文件系统
// =============================================================================

interface RawSessionInfo {
  id: string;
  path: string;
  name?: string;
  created: Date;
  modified: Date;
  messageCount: number;
  firstMessage: string;
}

/** 读取会话目录下所有 .jsonl 文件，提取摘要信息 */
function listSessions(sessionDir: string): RawSessionInfo[] {
  if (!existsSync(sessionDir)) return [];

  const files = readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(sessionDir, f));

  const sessions: RawSessionInfo[] = [];

  for (const filePath of files) {
    try {
      const info = readSessionFile(filePath);
      if (info) sessions.push(info);
    } catch {
      // 跳过损坏的文件
    }
  }

  // 按创建时间降序排列（最新的在前）
  sessions.sort((a, b) => b.created.getTime() - a.created.getTime());
  return sessions;
}

/** 读取单个 .jsonl 文件的头信息，提取会话摘要 */
function readSessionFile(filePath: string): RawSessionInfo | null {
  const stat = statSync(filePath);
  if (!stat.isFile()) return null;

  const content = readFileSync(filePath, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return null;

  // 第一行必须是 SessionHeader
  let header: any;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    return null;
  }
  if (header.type !== "session" || !header.id) return null;

  // 扫描 session_info 条目获取名称
  let name: string | undefined;
  let firstMsg: string = "";
  let msgCount = 0;

  for (let i = 1; i < lines.length; i++) {
    try {
      const entry = JSON.parse(lines[i]);
      if (entry.type === "session_info" && entry.name) {
        name = entry.name;
      }
      // 统计消息数（user 和 assistant 消息）
      if (entry.type === "message" && entry.role && (entry.role === "user" || entry.role === "assistant")) {
        msgCount++;
        if (!firstMsg && entry.role === "user") {
          const c = entry.content;
          firstMsg = typeof c === "string" ? c : Array.isArray(c) ? c.map((p: any) => p.text || "").join(" ") : "";
        }
      }
    } catch {
      // 跳过损坏行
    }
  }

  return {
    id: header.id,
    path: filePath,
    name,
    created: new Date(header.timestamp || stat.mtime),
    modified: stat.mtime,
    messageCount: msgCount,
    firstMessage: firstMsg,
  };
}

/** 按 ID 前缀或序号匹配会话（序号从 1 开始，对应 list 显示的次序） */
function resolveSession(sessions: RawSessionInfo[], target: string): RawSessionInfo | null {
  const idx = parseInt(target, 10);
  if (!isNaN(idx) && idx >= 1 && idx <= sessions.length) {
    return sessions[idx - 1];
  }
  return sessions.find((s) => s.id.startsWith(target)) ?? null;
}
