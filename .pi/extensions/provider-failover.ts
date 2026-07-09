import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import {
  probeAll,
  formatStatus,
  PROVIDERS,
} from "./lib/provider-health.mjs";
// @ts-ignore
import { auditLog } from "./lib/phi-crypto.mjs";
// @ts-ignore
import { loadRegistry, checkStaleness } from "./lib/kb-sources.mjs";
import { join } from "node:path";

/**
 * Provider 故障转移 + 知识库可观测扩展
 *
 * 职责：
 *   1. /failover 命令：展示各 Provider 健康排行与当前选定（依据 .pi/failover-selection.json）。
 *   2. 周期健康监控：每 5 分钟探测一次，健康态跃迁（健康↔异常）记 audit 日志，
 *      供运维发现 Provider 抖动/宕机，契合「可观测性」红线。
 *   3. /kb 命令：展示知识库来源登记表的过期情况（扩展战役的可观测入口）。
 *
 * 说明：Pi 运行时无 Provider 调用拦截钩子，真正切换发生在「启动编排」
 *      （scripts/launch-with-failover.mjs 写入 .pi/failover-selection.json，由 start 脚本读入 --model）。
 *      本扩展负责运行时可见性与审计，与启动编排构成完整故障转移闭环。
 */

const MONITOR_INTERVAL_MS = 5 * 60 * 1000; // 5 分钟
let monitorTimer: ReturnType<typeof setInterval> | null = null;
let lastHealthy = new Map<string, boolean>();

function selectionPath() {
  return join(process.cwd(), ".pi", "failover-selection.json");
}

async function readSelection(): Promise<any | null> {
  try {
    const { readFileSync, existsSync } = await import("node:fs");
    if (!existsSync(selectionPath())) return null;
    return JSON.parse(readFileSync(selectionPath(), "utf-8"));
  } catch {
    return null;
  }
}

async function monitorOnce() {
  try {
    const results = await probeAll();
    for (const r of results) {
      const key = `${r.provider}|${r.model}`;
      const prev = lastHealthy.get(key);
      if (prev !== undefined && prev !== r.healthy) {
        // 健康态跃迁：记审计
        auditLog("provider.health_transition", {
          provider: r.provider,
          model: r.model,
          to: r.healthy ? "healthy" : "unhealthy",
          reason: r.reason,
        });
        process.stderr.write(
          `[failover] ${r.provider}/${r.model} 状态跃迁 → ${r.healthy ? "健康" : "异常"}: ${r.reason}\n`,
        );
      }
      lastHealthy.set(key, r.healthy);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[failover] 周期监控异常: ${msg}\n`);
    auditLog("provider.monitor_error", { error: msg });
  }
}

export default function (pi: ExtensionAPI) {
  // /failover 命令
  pi.registerCommand("failover", {
    description: "Show Provider health ranking and current failover selection",
    handler: async (_args: string, ctx: any) => {
      await monitorOnce(); // 即时刷新一次
      const sel = await readSelection();
      const selLine = sel
        ? `当前选定: ${sel.provider}/${sel.model} (${sel.degraded ? "⚠ 降级" : "✓ 健康"})\n  理由: ${sel.reason}`
        : "当前选定: (未知，请先运行启动编排 scripts/launch-with-failover.mjs)";
      ctx.ui.notify(
        `Provider 健康排行:\n${formatStatus()}\n\n${selLine}`,
        "info",
      );
    },
  });

  // /kb 命令：知识库来源过期可观测
  pi.registerCommand("kb", {
    description: "Show knowledge-base source registry staleness",
    handler: async (_args: string, ctx: any) => {
      try {
        const reg = loadRegistry();
        const { stale, fresh } = checkStaleness(reg);
        const lines = [
          `知识库来源登记: 共 ${reg.sources.length} 项`,
          `  过期待查: ${stale.length}`,
          `  新鲜有效: ${fresh.length}`,
        ];
        if (stale.length > 0) {
          lines.push("  过期待查来源:");
          for (const s of stale) {
            lines.push(`    - ${s.id} (${s.name}) cadence=${s.cadenceDays}d`);
          }
        }
        ctx.ui.notify(lines.join("\n"), "info");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`/kb 读取失败: ${msg}`, "error");
      }
    },
  });

  // 启动周期监控（会话级，仅一次）
  if (!monitorTimer) {
    monitorOnce(); // 立即首探，填充基线
    monitorTimer = setInterval(monitorOnce, MONITOR_INTERVAL_MS);
    // 不 unref：保持会话存活期间持续监控；会话结束进程退出即止
  }

  // 会话关闭时清理定时器，避免句柄泄漏
  pi.on("session_shutdown", () => {
    if (monitorTimer) {
      clearInterval(monitorTimer);
      monitorTimer = null;
    }
  });
}
