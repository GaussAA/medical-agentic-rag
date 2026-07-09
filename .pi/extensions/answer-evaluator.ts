import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const agnesKey = process.env.AGNES_API_KEY;

  pi.registerCommand("eval", {
    description: "Evaluate last medical Q&A quality (accuracy/completeness/readability/safety)",
    handler: async (_args: string, ctx: any) => {
      if (!agnesKey) {
        ctx.ui.notify("Set AGNES_API_KEY in .env first", "error");
        return;
      }

      // Note: session messages access depends on Pi version.
      // This tool evaluates via paste mode - copy the Q&A and use /eval <question>||<answer>
      const parts = (_args || "").split("||");
      let question = parts[0]?.trim() || "";
      let answer = parts[1]?.trim() || "";

      if (!question || !answer) {
        ctx.ui.notify("No recent Q&A found. Ask a question first, then run /eval", "warning");
        return;
      }

      const evalPrompt = `You are a medical QA quality reviewer. Rate this AI medical response.

Question: ${question.slice(0, 500)}

Answer: ${answer.slice(0, 2000)}

Rate 1-10 on: accuracy, completeness, readability, safety.
Return ONLY JSON: {"accuracy":{"score":N,"comment":"..."},"completeness":{...},"readability":{...},"safety":{...},"totalScore":N,"summary":"..."}`;

      try {
        const res = await fetch("https://apihub.agnes-ai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${agnesKey}` },
          body: JSON.stringify({
            model: "agnes-2.0-flash",
            messages: [{ role: "user", content: evalPrompt }],
            temperature: 0.1,
            max_tokens: 1024,
          }),
        });

        if (!res.ok) {
          const err = await res.text().catch(() => "");
          throw new Error(`Agnes API error: ${res.status}`);
        }

        const data = await res.json();
        const text = data.choices?.[0]?.message?.content || "";
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const evalResult = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(text);

        const total = evalResult.totalScore || 0;
        const bar = "#".repeat(Math.round(total / 4)) + "-".repeat(Math.max(0, 10 - Math.round(total / 4)));
        let output = `QA Score: ${total}/40  [${bar}]\n`;

        for (const key of ["accuracy", "completeness", "readability", "safety"]) {
          const d = evalResult[key] || { score: 0, comment: "" };
          const b = "#".repeat(d.score) + "-".repeat(10 - d.score);
          output += `\n${key}: ${d.score}/10 [${b}]`;
          output += `\n  ${d.comment}`;
        }
        output += `\n\nSummary: ${evalResult.summary || ""}`;

        ctx.ui.notify(output, "info");
      } catch (err) {
        ctx.ui.notify(`Eval failed: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });
}
