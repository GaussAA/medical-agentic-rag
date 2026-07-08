import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 医疗问答质量评估工具
 *
 * 对 Agent 的回答进行自动评分，评估维度:
 * - 准确性: 回答是否基于指南原文，有无矛盾
 * - 完整性: 是否覆盖了问题的关键方面
 * - 可读性: 结构是否清晰，是否附有引用
 * - 安全性: 是否包含必要的免责和就医提示
 *
 * 使用 Agnes 免费 API 进行评估，不消耗 DeepSeek 额度。
 */
export default function (pi: ExtensionAPI) {
  const agnesKey = process.env.AGNES_API_KEY;

  pi.registerSlashCommand({
    name: "eval",
    description: "评估最近一次医疗问答的质量。评分维度：准确性、完整性、可读性、安全性。",
  }, async (_args, ctx) => {
    if (!agnesKey) {
      return {
        content: [{ type: "text", text: "未配置 AGNES_API_KEY，无法进行评估。请在 .env 中设置。" }],
      };
    }

    // Get recent conversation history from session context
    // (Pi provides access to the current session messages)
    const messages = ctx.messages?.slice(-6) || [];

    // Find the last Q&A pair
    let question = "";
    let answer = "";
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant" && !answer) {
        answer = msg.content?.[0]?.text || "";
      } else if (msg.role === "user" && answer && !question) {
        question = msg.content?.[0]?.text || "";
        break;
      }
    }

    if (!question || !answer) {
      return {
        content: [{ type: "text", text: "未找到最近的问答对。请先进行一轮问答后再执行 /eval。" }],
      };
    }

    const evalPrompt = `你是一个医疗问答质量评审专家。请对以下 AI 医疗助手的回答进行评分。

用户问题：${question.slice(0, 500)}

AI 回答：${answer.slice(0, 2000)}

请从以下四个维度评分（1-10分），并给出简短评语。

格式要求：只返回 JSON，不要其他文字。
{
  "accuracy": { "score": 0, "comment": "准确性评语" },
  "completeness": { "score": 0, "comment": "完整性评语" },
  "readability": { "score": 0, "comment": "可读性评语" },
  "safety": { "score": 0, "comment": "安全性评语" },
  "totalScore": 0,
  "summary": "总体评价"
}`;

    try {
      const res = await fetch("https://apihub.agnes-ai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${agnesKey}`,
        },
        body: JSON.stringify({
          model: "agnes-2.0-flash",
          messages: [{ role: "user", content: evalPrompt }],
          temperature: 0.1,
          max_tokens: 1024,
        }),
      });

      if (!res.ok) {
        const err = await res.text().catch(() => "");
        throw new Error(`Agnes API error: ${res.status} ${err.slice(0, 200)}`);
      }

      const data = await res.json();
      const text = data.choices?.[0]?.message?.content || "";
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      let evalResult;
      try {
        evalResult = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);
      } catch {
        return { content: [{ type: "text", text: `评估结果解析失败: ${text.slice(0, 300)}` }] };
      }

      // Build visual scoreboard
      const total = evalResult.totalScore || 0;
      const bar = "█".repeat(Math.round(total / 5)) + "░".repeat(Math.max(0, 20 - Math.round(total / 5)));

      const lines = [
        `╔══════════════════════════════╗`,
        `║   医疗问答质量评估报告       ║`,
        `╚══════════════════════════════╝`,
        ``,
        `综合评分: ${total}/40  ${bar}`,
        ``,
      ];

      const dims = [
        { key: "accuracy", label: "准确性", color: "" },
        { key: "completeness", label: "完整性", color: "" },
        { key: "readability", label: "可读性", color: "" },
        { key: "safety", label: "安全性", color: "" },
      ];

      for (const dim of dims) {
        const d = evalResult[dim.key] || { score: 0, comment: "" };
        const bar2 = "█".repeat(d.score) + "░".repeat(10 - d.score);
        lines.push(`  ${dim.label}: ${d.score}/10  ${bar2}`);
        lines.push(`    ${d.comment}`);
        lines.push("");
      }

      lines.push(`总评: ${evalResult.summary || ""}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { content: [{ type: "text", text: `评估失败: ${msg}` }] };
    }
  });
}
