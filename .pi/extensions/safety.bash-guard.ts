import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// 官方 bash 工具工厂——经 jiti 别名系统映射到包入口 (dist/index.js)，
// 同时兼容本地 workspace 链接与 Docker npm 全局安装。
import { createBashTool } from "@earendil-works/pi-coding-agent";
// @ts-ignore —— .mjs 纯 JS 共享库，由 Pi 的 jiti 加载器解析
import {
  normalizeBashParams,
  resolveTimeoutSec,
  assessCommand,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
} from "./lib/bash-guard.mjs";
// @ts-ignore
import { auditLog } from "./lib/phi-crypto.mjs";

/**
 * bash 护栏扩展 —— P0 加固（防 2026-07-11 会话「find / 全盘扫描 16 分钟卡死」复发）
 *
 * 机制：内置 bash 工具默认「无超时」，且无命令预检——这是卡死能发生的底层成因。
 *       本扩展用官方 createBashTool（功能等价，schema/UI 完全一致）重建 bash 工具，
 *       并以同名 registerTool 覆盖内置版本，在 execute 包装层加两道保险：
 *
 *   保险一（拦截）：危险命令硬拦截。find / 全盘扫描、系统目录递归、/mnt/data 幻觉路径
 *                  等直接拒绝，根本不启动子进程，并引导模型改用检索工具。
 *   保险二（超时）：强制默认超时。模型未传 timeout → ${DEFAULT_TIMEOUT_SEC}s；
 *                  超 ${MAX_TIMEOUT_SEC}s → 夹紧。即便拦截规则漏网，最坏也在超时后被 kill，
 *                  彻底杜绝分钟级卡死。
 *
 * 详见 docs/session-stall-analysis-2026-07-11.md。
 */
export default function (pi: ExtensionAPI) {
  const cwd = process.cwd();

  const bashTool = createBashTool(cwd, {
    // spawnHook 作二次防线：标记命令已过护栏（便于审计/排障）
    spawnHook: ({ command, cwd, env }: any) => ({
      command,
      cwd,
      env: { ...env, MED_BASH_GUARD: "1" },
    }),
  });

  pi.registerTool({
    ...bashTool,
    execute: async (
      id: string,
      rawParams: any,
      signal: any,
      onUpdate: any,
      ctx: any,
    ) => {
      const { command, timeout } = normalizeBashParams(rawParams);

      // —— 保险一：危险命令拦截（拒绝执行，不启动子进程）——
      const verdict = assessCommand(command);
      if (verdict.blocked) {
        try {
          auditLog("bash_guard.block", {
            category: verdict.category,
            cmd: command.slice(0, 200),
          });
        } catch {
          /* 审计失败不得阻断主流程 */
        }
        throw new Error(
          `命令被医疗 Agent 安全护栏拦截。原因：${verdict.reason} ` +
            `检索医疗指南请使用 guide_finder（语义路由）或 rag_search 工具；` +
            `若两次检索仍未命中，请直接基于现有证据作答或声明该主题未收录，切勿降级到 shell 扫描文件系统。`,
        );
      }

      // —— 保险二：强制默认 / 夹紧超时 ——
      const finalTimeout = resolveTimeoutSec(timeout);
      const guardedParams = { command, timeout: finalTimeout };

      return bashTool.execute(id, guardedParams, signal, onUpdate, ctx);
    },
  });
}
