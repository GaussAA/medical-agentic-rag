import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
// @ts-ignore —— .mjs 纯 JS 共享模块，由 Pi 的 jiti 加载器解析
import { detectScope } from "./lib/scope-guard.mjs";
import { logGuardHit } from "./lib/observability.mjs";
// @ts-ignore —— 诊断统一出口，例程诊断落 logs/ 不污染终端
import { diag } from "./lib/diagnostic-log.mjs";
import { alert } from "./lib/alert-log.mjs";

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
 *   2) 越界 → 将原用户消息**替换**为护栏拒答指令，使 LLM 彻底看不见原问题，
 *      从根本上杜绝回答/编造。并 logGuardHit 埋点。
 *      （此前为注入 system 指令，但 Q39 证实 LLM 仍可见原问题并编造病史）
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
        }).catch((e: any) =>
          alert(
            "scope-guard",
            `埋点落盘失败，拒答仍生效: ${e?.message || e}`,
          ),
        );
        // 🔐 强护栏：替换原用户消息为拒答指令，LLM 看不见原问题→杜绝回答/编造
        // （此前仅注入 system 指令但 LLM 仍可见原问题，Q39 因此编造了肝硬化病史）
        return {
          messages: msgs.map((m: any) => {
            if (m.role === "user" && m.content === userText) {
              return {
                role: "user" as const,
                content: `【护栏拦截】用户的问题已被系统安全护栏拦截，原因：${verdict.reason}。请用一句中文礼貌拒绝：说明本系统只处理医疗健康问题，不提供此类服务。严禁回答原问题，严禁编造无关的医疗信息。`,
                timestamp: Date.now(),
              };
            }
            return m;
          }),
        };
      }
    } catch (e: any) {
      // 判定异常：放行，不阻断（无静默失败，仅告警）
      diag.warn("scope-guard", "判定异常，放行: " + (e?.message || e));
    }
    return; // 放行（不修改 messages）
  });
}
