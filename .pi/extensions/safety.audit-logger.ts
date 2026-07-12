import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { lastUserText, isNewUserTurn, auditTurn } from "./lib/audit-logger.mjs";
// @ts-ignore —— 诊断统一出口，例程诊断落 logs/ 不污染终端
import { diag } from "./lib/diagnostic-log.mjs";

/**
 * 审计链运行期接线（会话级审计）
 * -----------------------------------------------------------------------------------
 * 此前 audit-chain 哈希链仅被 data-lifecycle / audit-verify 等运维脚本调用，
 * Agent 运行时无钩子接线 → 会话级审计缺失。本扩展将每次会话的「用户轮 / 助手响应 /
 * 会话起止」以防篡改哈希链（prevHash 链 + HMAC 签名）落入 logs/audit-<date>.ndjson，
 * 使审计在运行期真正生效、不可否认。
 *
 * 接入点（Pi 可用钩子：context / message_end / session_start / session_shutdown；
 * 注意：无 tool_call 钩子，故工具级审计改由各工具（如 rag_search）在执行入口自行调用
 * auditChainLog，本扩展负责会话级框架审计）：
 *   1) session_start → auditTurn("session_start")
 *   2) context       → 检测到「新用户轮」(lastUserText 变化) 才记 user_turn（去重，避免重复）
 *   3) message_end   → auditTurn("agent_response")
 *   4) session_shutdown → auditTurn("session_end")
 *
 * 行为：仅记字段名/长度等元数据（queryLen/turn/kbId），绝不记查询原文或患者 PII；
 *   审计写入失败（磁盘/权限）绝不阻断对话或检索（无静默失败，仅 stderr 告警）。
 * 原则契合：免费优先（零 LLM）、无静默失败、双可测（.mjs 纯函数单测）、显式错误捕获。
 */

export default function (pi: ExtensionAPI) {
  let lastSeenUser = "";
  let turn = 0;

  // 会话起止：框定审计边界
  pi.on("session_start", () => {
    auditTurn("session_start", {});
  });

  // 每轮 LLM 调用前：仅在新用户轮时落审计（去重，避免同问题多次 round 重复记）
  pi.on("context", async (event: any) => {
    try {
      const msgs: any[] = (event && event.messages) || [];
      const text = lastUserText(msgs);
      if (isNewUserTurn(lastSeenUser, text)) {
        turn++;
        lastSeenUser = text;
        auditTurn("user_turn", { turn, queryLen: text.length });
      }
    } catch (e: any) {
      diag.warn("audit-logger", "context 审计异常，跳过: " + (e?.message || e));
    }
    return; // 原样放行，不修改 messages
  });

  // 助手响应结束：记一笔响应事件（链完整性，便于事后回溯整轮）
  pi.on("message_end", async () => {
    try {
      auditTurn("agent_response", {});
    } catch (e: any) {
      diag.warn("audit-logger", "message_end 审计异常，跳过: " + (e?.message || e));
    }
  });

  // 会话结束：闭合审计边界
  pi.on("session_shutdown", () => {
    auditTurn("session_end", {});
  });
}
