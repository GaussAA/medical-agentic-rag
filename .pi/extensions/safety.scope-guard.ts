import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { detectScope, SCOPE_REFUSAL_DIRECTIVE } from "./lib/scope-guard.mjs";
import { logGuardHit } from "./lib/observability.mjs";

/**
 * 越界（非医疗）请求扩展级拦截
 * -----------------------------------------------------------------------------------
 * 接入点：Pi 的 on("context") 钩子 —— 每轮 LLM 调用前检测最后一条 user message，
 *   越界时注入 system 拒答指令并埋点，形成「代码层确定性判定 + 强制拒答」的硬护栏，
 *   弥补纯 System Prompt 软约束（LLM 可能忽略）的不足。
 *
 * 行为：
 *   1) on("context") 取 messages 最后一条 user，调 lib/scope-guard 的 detectScope
 *      （纯确定性、零 LLM、医疗白名单 + 非医疗黑名单，保守放行避免误伤）。
 *   2) 越界 → 在上下文最前注入 system 拒答指令（保留原对话，引导 LLM 仅礼貌拒答），
 *      并 logGuardHit({type:"scope", action:"refuse"}) 埋点（可观测、可审计）。
 *   3) 不越界 / 判定异常 → 原样放行，零开销（无静默失败，异常仅告警）。
 *
 * 原则契合：免费优先（无 LLM 调用）、无静默失败、双可测（.mjs 纯函数单测）、显式错误捕获。
 */

export default function (pi: ExtensionAPI) {
  pi.on("context", async (event: any) => {
    try {
      const msgs: any[] = (event && event.messages) || [];
      let userText = "";
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === "user") {
          const c = msgs[i].content;
          userText =
            Array.isArray(c) && c[0] && c[0].text
              ? c[0].text
              : typeof c === "string"
                ? c
                : "";
          break;
        }
      }
      if (!userText.trim()) return; // 无用户问题，放行

      const verdict = detectScope(userText);
      if (verdict.outOfScope) {
        logGuardHit({
          type: "scope",
          action: "refuse",
          reason: verdict.reason,
        }).catch(() => {});
        return {
          messages: [
            { role: "system", content: SCOPE_REFUSAL_DIRECTIVE },
            ...msgs,
          ],
        };
      }
    } catch (e: any) {
      // 判定异常：放行，不阻断（无静默失败，仅告警）
      process.stderr.write(`[scope-guard] 判定异常，放行: ${e?.message || e}\n`);
    }
    return; // 放行（不修改 messages）
  });
}
