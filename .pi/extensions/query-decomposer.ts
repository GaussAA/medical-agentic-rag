import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 查询分解工具
 *
 * 将复杂医学问题拆解为子问题序列，每个子问题可独立搜索。
 * 支持对比类（A vs B）、综合类（A的X,Y,Z）问题的分解。
 */
export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "query_decomposer",
    description:
      "将复杂的医学问题拆解为多个子查询。适用于对比类问题（如'比较A和B的治疗'）" +
      "或综合类问题（如'A的病因、诊断和治疗'）。拆解后可为每个子查询指定目标指南和搜索策略。",
    promptSnippet: "Decompose a complex medical question into sub-queries",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "用户的原始复杂问题",
        },
      },
      required: ["question"],
    },
    execute: async (params) => {
      const question = (params.question || "").trim();
      if (!question) {
        return { content: [{ type: "text", text: "请提供需要分解的问题。" }] };
      }

      // Detect question type
      const hasCompare = /比较|对比|差异|区别|vs|versus|versus|不同|哪个更好/.test(question);
      const hasMultiAspect = /同时|及、|与、|、|和的.{0,10}(治疗|诊断|预后|症状|预防)(治疗|诊断|预后|症状|预防)/.test(question);

      // Build decomposition plan
      const subQueries = [];
      const lines = [`原始问题: ${question}\n`];

      if (hasCompare) {
        lines.push("问题类型: 对比类\n");
        lines.push("分解策略: 分别查询各对象后对比\n");

        // Try to extract comparison subjects
        const subjects = question
          .replace(/比较|对比|差异|区别|vs|versus/g, " ")
          .split(/和|与|、|及/)
          .map((s) => s.trim())
          .filter((s) => s.length > 1);

        const aspects = ["治疗方案", "诊断方法", "预后情况"];

        if (subjects.length >= 2) {
          for (let i = 0; i < Math.min(subjects.length, 3); i++) {
            // Use guide_finder to find relevant guide
            subQueries.push({
              step: i + 1,
              subQuery: `${subjects[i]}的治疗方案和诊断方法`,
              targetGuide: `搜索: "${subjects[i]}"`,
              searchMode: "deep",
            });
          }

          // Add comparison step
          subQueries.push({
            step: subQueries.length + 1,
            subQuery: `对比${subjects[0]}和${subjects[1]}的异同`,
            targetGuide: "融合多份指南结果",
            searchMode: "adaptive",
          });
        } else {
          // Fallback: aspect-based decomposition
          for (let i = 0; i < aspects.length; i++) {
            subQueries.push({
              step: i + 1,
              subQuery: `${question} - ${aspects[i]}`,
              targetGuide: "待 guide_finder 定位",
              searchMode: "hybrid",
            });
          }
        }
      } else {
        lines.push("问题类型: 综合类\n");
        lines.push("分解策略: 按维度拆解\n");

        // Aspect-based decomposition
        const standardAspects = [
          { label: "定义与病因", keywords: "定义 病因 危险因素" },
          { label: "诊断方法", keywords: "诊断 筛查 检查 分期" },
          { label: "治疗方案", keywords: "治疗 药物 手术 放疗 化疗" },
          { label: "预后与预防", keywords: "预后 预防 随访 康复" },
        ];

        for (let i = 0; i < standardAspects.length; i++) {
          subQueries.push({
            step: i + 1,
            subQuery: `${question} 的${standardAspects[i].label}`,
            targetGuide: "待 guide_finder 定位",
            searchMode: "hybrid",
            keywords: standardAspects[i].keywords,
          });
        }
      }

      lines.push(`分解为 ${subQueries.length} 个子查询:\n`);
      for (const sq of subQueries) {
        lines.push(`  [步骤${sq.step}] ${sq.subQuery}`);
        lines.push(`          目标: ${sq.targetGuide}`);
        lines.push(`          模式: ${sq.searchMode}`);
        lines.push("");
      }

      lines.push("执行建议:\n");
      lines.push("1. 对每个子查询先调 guide_finder 确定目标指南");
      lines.push("2. 用 knowledge_search 搜索各子查询");
      lines.push("3. 搜索时使用对应子查询建议的 searchMode");
      lines.push("4. 汇总各子查询结果，给出综合性回答");
      if (hasCompare) {
        lines.push("5. 最后一步：对比分析异同，用表格呈现差异");
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    },
  });
}
