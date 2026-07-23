import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getMessageText } from "./lib/faithfulness-guard.mjs";

/**
 * 在线 faithfulness / 安全护栏
 * -----------------------------------------------------------------------------------
 * 历史（2026-07-19）：曾用 pi.on("message_end") 每次回答后执行 LLM 四维评审，
 * 但 41 题评测忠实 0.929/安全 0.998 几乎从不触发批注。评审阻塞 UI spinner 长达数秒，
 * 用户感知"回答已显示但 spinner 不消失"。经大帅确认，移除 message_end 评审阻塞。
 *
 * 安全保障移交 CI 门禁（eval-ci-gate.mjs HARD 卡点，忠实 <0.7 拦截）。
 * context 钩子保留：缓存用户问题，供懒评审/未来扩展复用。
 */

let lastUserQuestion = "";

export default function (pi: ExtensionAPI) {
  // 缓存本轮用户问题（仅副作用，不重写上下文）
  pi.on("context", (event: any) => {
    try {
      const msgs: any[] = (event && event.messages) || [];
      for (let i = msgs.length - 1; i >= 0; i--) {
        if (msgs[i] && msgs[i].role === "user") {
          lastUserQuestion = getMessageText(msgs[i]);
          break;
        }
      }
    } catch {
      /* 不影响主流程 */
    }
  });
}
