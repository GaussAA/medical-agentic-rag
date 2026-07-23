import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { judgeAnswer } from "./lib/llm-judge.mjs";

// 交互式 /eval 复用 lib/llm-judge.mjs 的 judgeAnswer（与批量基座 answer-quality-judge.mjs
// 共用框架规范四维口径 + 免费优先回退），消除「交互/批量双口径」漂移。

export default function (pi: ExtensionAPI) {
  // ctx 为 Pi 运行期命令上下文，类型较松，按既有扩展惯例以 any 承接并显式标注。
  pi.registerCommand("eval", {
    description: "Evaluate medical Q&A quality (faithfulness/relevance/clinical-correctness/safety)",
    handler: async (_args: string, ctx: any) => {
      // 粘贴模式：/eval <问题>||<回答>
      const parts = (_args || "").split("||");
      const question = parts[0]?.trim() || "";
      const answer = parts[1]?.trim() || "";

      if (!question || !answer) {
        ctx.ui.notify("用法：/eval <问题>||<回答>", "warning");
        return;
      }

      if (!process.env.SENSENOVA_API_KEY && !process.env.DEEPSEEK_API_KEY) {
        ctx.ui.notify("设置 SENSENOVA_API_KEY 或 DEEPSEEK_API_KEY 后启用四维评分", "error");
        return;
      }

      try {
        const j = await judgeAnswer({ question, answer });
        if (j.skipped) {
          ctx.ui.notify(`评测失败：${j.reason}`, "error");
          return;
        }

        const dims: [string, number][] = [
          ["忠实 Faithfulness", j.faithfulness],
          ["相关 Relevance", j.answerRelevance],
          ["临床正确性 Clinical", j.clinicalCorrectness],
          ["安全 Safety", j.safety],
        ];
        const bar = (v: number) =>
          "█".repeat(Math.max(0, Math.min(10, Math.round(v * 10)))) +
          "░".repeat(10 - Math.max(0, Math.min(10, Math.round(v * 10))));

        let output = `QA 四维评审（0–1，免费模型优先）\n`;
        for (const [name, v] of dims) {
          output += `\n${name}: ${v.toFixed(2)} [${bar(v)}]`;
        }
        const total = (j.faithfulness + j.answerRelevance + j.clinicalCorrectness + j.safety) / 4;
        output += `\n\n总分: ${total.toFixed(2)}/1.0  (≈${(total * 40).toFixed(0)}/40)`;
        output += `\n\n理由: ${j.reasons}`;

        ctx.ui.notify(output, "info");
      } catch (err) {
        ctx.ui.notify(`Eval failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
