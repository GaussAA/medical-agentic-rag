import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * 医疗 Agent 监控日志扩展
 *
 * 记录会话生命周期事件到 logs/ 目录，便于故障排查和质量分析。
 * 日志文件按日期滚动：logs/YYYY-MM-DD.ndjson
 */
export default function (pi: ExtensionAPI) {
  const logsDir = join(process.cwd(), "logs");

  async function logEntry(event: string, data: Record<string, unknown>) {
    try {
      await mkdir(logsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const logFile = join(logsDir, `${date}.ndjson`);
      const entry = JSON.stringify({
        t: new Date().toISOString(),
        event,
        ...data,
      }) + "\n";
      await appendFile(logFile, entry, "utf-8");
    } catch {
      // Silently ignore logging failures
    }
  }

  // 会话启动
  pi.on("session_start", async (_event, ctx) => {
    await logEntry("session_start", {
      cwd: ctx.cwd,
      sessionId: ctx.sessionId,
    });
  });

  // 用户提交提示词
  pi.on("before_agent_start", async (event, _ctx) => {
    await logEntry("prompt", {
      promptLength: event.prompt.length,
      hasImages: Array.isArray(event.images) && event.images.length > 0,
    });
  });

  // 会话关闭
  pi.on("session_shutdown", async (_event, ctx) => {
    await logEntry("session_shutdown", {
      sessionId: ctx.sessionId,
    });
  });

  // 注册 /logs 命令，查看最近日志
  pi.registerSlashCommand({
    name: "logs",
    description: "显示本次会话的日志统计",
  }, async (_args) => {
    return { content: [{ type: "text", text: `日志目录: ${logsDir}\n日志按日期滚动存储，格式为 NDJSON。` }] };
  });
}
