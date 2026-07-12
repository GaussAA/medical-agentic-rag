// audit-logger.mjs
// 审计链运行期接线辅助（纯函数 + 薄封装）。
// 与 lib/audit-chain.mjs 协作：将 Agent 会话事件（用户轮/助手响应/检索动作）写入
// 防篡改哈希链（prevHash 链 + HMAC 签名），使「会话级审计」在 Agent 运行时真正生效，
// 而非仅被 data-lifecycle / audit-verify 等运维脚本调用。
//
// 设计纪律：
//   · 纯函数可测：lastUserText / isNewUserTurn 零副作用，原生 node 直接单测。
//   · 无静默失败：auditTurn 内部异常由 auditChainLog 捕获（其永不抛出，失败返回 null），
//     即便审计写入失败也绝不阻断主流程（检索/对话照常）。
//   · 合规：审计仅记字段名/长度等元数据，绝不记查询原文或患者 PII。

import { auditChainLog } from "./audit-chain.mjs";
import { logAuditEvent } from "./observability.mjs";

/**
 * 从 messages 数组抽取最后一条 user 文本。
 * 兼容 content 为 [{type:"text",text}] 数组 / 纯字符串 / 缺失。
 * @param {Array} messages
 * @returns {string}
 */
export function lastUserText(messages) {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === "user") {
      const c = m.content;
      if (Array.isArray(c) && c[0] && typeof c[0].text === "string") return c[0].text;
      if (typeof c === "string") return c;
      return "";
    }
  }
  return "";
}

/**
 * 是否为「新用户轮」：当前 user 文本非空且与上一轮看到的 user 文本不同。
 * 用于 context 钩子去重，避免同一用户问题在多次 round 中被重复审计。
 * @param {string} prevText
 * @param {string} currText
 * @returns {boolean}
 */
export function isNewUserTurn(prevText, currText) {
  return !!currText && currText !== prevText;
}

/**
 * 封装一次审计写入。字段仅含长度/计数等元数据（不含原文——合规红线）。
 * 委托 auditChainLog（其自带 try/catch，失败返回 null，绝不抛出），
 * 此处再包一层防御，确保调用方无需关心审计可用性。
 * @param {string} action
 * @param {object} [fields]
 * @returns {{hash:string,prevHash:string}|null}
 */
export function auditTurn(action, fields = {}) {
  // 聚合：审计事件同步落 observability ndjson（与护栏同源 schema），便于统一聚合
  try {
    logAuditEvent({ action }).catch(() => {});
  } catch {}
  try {
    return auditChainLog(action, fields);
  } catch {
    return null;
  }
}
