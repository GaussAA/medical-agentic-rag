import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  const logsDir = join(process.cwd(), "logs");

  async function logEntry(event: string, data: Record<string, unknown>) {
    try {
      await mkdir(logsDir, { recursive: true });
      const date = new Date().toISOString().slice(0, 10);
      const entry = JSON.stringify({ t: new Date().toISOString(), event, ...data }) + "\n";
      await appendFile(join(logsDir, `${date}.ndjson`), entry, "utf-8");
    } catch { /* silent */ }
  }

  pi.on("session_start", async (event, ctx) => {
    const data = event as any;
    await logEntry("session_start", { cwd: ctx.cwd, sessionId: data.sessionId });
  });

  pi.on("before_agent_start", async (event, _ctx) => {
    const data = event as any;
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
      ctx.ui.notify(`Logs directory: ${logsDir}\nLogs are stored as NDJSON, one file per day.`, "info");
    },
  });
}
