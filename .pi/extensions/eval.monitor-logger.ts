import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir, readFile, readdir, stat, rename } from "node:fs/promises";
import { join } from "node:path";
import { alert } from "./lib/alert-log.mjs";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { auditFileToday } from "./lib/phi-crypto.mjs";

/**
 * 可观测性 / 审计扩展
 *
 * 两条日志通道，职责分离：
 *   - logs/YYYY-MM-DD.ndjson       —— 业务运行日志（会话生命周期、埋点计数）
 *   - logs/audit-YYYY-MM-DD.ndjson —— 合规审计日志（PHI 读写留痕，由 lib/phi-crypto.mjs 写入）
 *
 * 合规原则：
 *   - 业务日志只记结构化计数（promptLength / hasImages），绝不记录 prompt 原文，
 *     从源头杜绝 PII 入日志（脱敏工具 maskPII 保留在 lib，供未来需记片段时调用）。
 *   - 显式错误：写日志失败不再静默吞掉，改写 stderr，避免可观测性断裂无人知晓。
 */
export default function (pi: ExtensionAPI) {
  const logsDir = join(process.cwd(), ".pi", "logs");

  async function logEntry(event: string, data: Record<string, unknown>) {
    try {
      await mkdir(logsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const entry =
        JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n";
      await appendFile(join(logsDir, `${date}.ndjson`), entry, "utf-8");
    } catch (err) {
      // 显式错误捕获：不静默，写 stderr 便于运维发现日志链路断裂
      const msg = err instanceof Error ? err.message : String(err);
      alert("monitor-logger", `日志写入失败: ${msg}`);
    }
  }

  pi.on("session_start", async (event, ctx) => {
    const data = event as any;
    await logEntry("session_start", { cwd: ctx.cwd, sessionId: data.sessionId });

    // ── 会话自动归档 ──────────────────────────────────────────
    // 每次新会话启动时将超限会话移入 .pi/archive/，而非删除。
    // 双条件保留（取更宽松）：最多 50 条 / 最长 30 天。
    try {
      const sessionDir = ctx.sessionManager?.getSessionDir?.();
      if (sessionDir) {
        await cleanupOldSessions(sessionDir, { maxCount: 50, maxDays: 30 });
      }
    } catch {
      // 清理失败不影响主流程
    }
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const data = event as any;
    // 只记计数，不记原文：prompt 原文可能含 PII，绝不落盘
    await logEntry("prompt", {
      promptLength: (data.prompt || "").length,
      hasImages: Array.isArray(data.images) && data.images.length > 0,
    });
  });

  pi.on("session_shutdown", async (event, _ctx) => {
    const data = event as any;
    await logEntry("session_shutdown", { sessionId: data.sessionId });
  });

  pi.registerCommand("logs", {
    description: "Show session log location and stats",
    handler: async (_args: string, ctx: any) => {
      ctx.ui.notify(
        `业务日志目录: ${logsDir}\n以 NDJSON 存储，每日一文件。仅记结构化计数，不含 prompt 原文。`,
        "info",
      );
    },
  });

  pi.registerCommand("audit", {
    description: "Show today's PHI audit trail (patient profile read/write)",
    handler: async (_args: string, ctx: any) => {
      const file = auditFileToday();
      try {
        const text = await readFile(file, "utf-8");
        const lines = text.trim().split("\n").filter(Boolean);
        const recent = lines.slice(-10).join("\n");
        ctx.ui.notify(
          `合规审计日志: ${file}\n共 ${lines.length} 条，最近 ${Math.min(10, lines.length)} 条:\n${recent}`,
          "info",
        );
      } catch {
        ctx.ui.notify(
          `合规审计日志: ${file}\n（今日暂无审计记录，PHI 读写时自动生成）`,
          "info",
        );
      }
    },
  });
}

// =============================================================================
// 会话自动归档
// =============================================================================

interface CleanupOptions {
  /** 最大保留活跃会话数（超出则归档最旧的） */
  maxCount: number;
  /** 活跃会话最大保留天数（超过则归档） */
  maxDays: number;
}

/**
 * 将超出保留限制的历史会话移入归档目录而非删除。
 * 双条件保留：同时满足 maxCount 和 maxDays 的会话才会留在活跃区。
 * 归档路径：.pi/archive/YYYY-MM/*.jsonl
 */
async function cleanupOldSessions(sessionDir: string, opts: CleanupOptions): Promise<void> {
  let files: string[];
  try {
    files = (await readdir(sessionDir))
      .filter((f) => f.endsWith(".jsonl"))
      .map((f) => join(sessionDir, f));
  } catch {
    return;
  }
  if (files.length <= opts.maxCount) return;

  const withMtime: { path: string; mtime: Date }[] = [];
  for (const f of files) {
    try {
      const s = await stat(f);
      if (s.isFile()) withMtime.push({ path: f, mtime: s.mtime });
    } catch { /* 跳过 */ }
  }

  withMtime.sort((a, b) => b.mtime.getTime() - a.mtime.getTime());
  const cutoff = Date.now() - opts.maxDays * 86400_000;
  let archived = 0;

  for (const f of withMtime) {
    const withinCount = withMtime.indexOf(f) < opts.maxCount;
    const withinDays = f.mtime.getTime() >= cutoff;
    if (withinCount && withinDays) continue;

    try {
      // 归档到 .pi/archive/YYYY-MM/ 目录，保留原名
      const monthDir = join(sessionDir, "..", "archive", f.mtime.toISOString().slice(0, 7));
      await mkdir(monthDir, { recursive: true });
      const dest = join(monthDir, f.path.split(/[/\\]/).pop()!);
      await rename(f.path, dest);
      archived++;
    } catch { /* 归档失败跳过 */ }
  }

  if (archived > 0) {
    console.log(`[session-cleanup] 归档 ${archived} 个历史会话 → .pi/archive/`);
  }
}
