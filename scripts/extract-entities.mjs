/**
 * 医学实体提取脚本
 * 使用 DeepSeek API 从指南大纲中提取结构化医学实体和关系
 *
 * 用法: set DEEPSEEK_API_KEY=xxx && node scripts/extract-entities.mjs
 * 输出: medical-knowlegde-base/.knowledge-graph.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTLINE_FILE = join(__dirname, "..", "medical-knowlegde-base", ".outline.json");
const GRAPH_FILE = join(__dirname, "..", "medical-knowlegde-base", ".knowledge-graph.json");

const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY;
if (!DEEPSEEK_API_KEY) {
  console.error("请设置 DEEPSEEK_API_KEY 环境变量");
  process.exit(1);
}

const API_URL = "https://api.deepseek.com/chat/completions";

async function callLLM(prompt) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${DEEPSEEK_API_KEY}`,
    },
    body: JSON.stringify({
      model: "deepseek-v4-flash",
      messages: [
        {
          role: "system",
          content:
            "你是一个医学知识工程师。请从给定的医疗指南章节标题中提取结构化知识。" +
            "只返回 JSON 数组，不要其他文字。每个条目格式：{\n" +
            '  "disease": "疾病名称",\n' +
            '  "entityType": "drug|symptom|examination|riskFactor|treatment",\n' +
            '  "entityName": "实体名称",\n' +
            '  "relation": "treated_with|has_symptom|diagnosed_by|has_risk|treated_by",\n' +
            '  "source": "指南名称"\n' +
            "}",
        },
        { role: "user", content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 4096,
    }),
  });

  if (!res.ok) {
    const err = await res.text().catch(() => "");
    throw new Error(`API error ${res.status}: ${err.slice(0, 200)}`);
  }

  const data = await res.json();
  const text = data.choices?.[0]?.message?.content || "";
  // Try to extract JSON from the response
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  // If response is NOT wrapped in array brackets, try to parse as-is
  try {
    return JSON.parse(text);
  } catch {
    console.warn("LLM 返回非 JSON:", text.slice(0, 200));
    return [];
  }
}

async function main() {
  const outline = JSON.parse(await readFile(OUTLINE_FILE, "utf-8"));

  console.log(`开始从 ${outline.totalFiles} 份指南提取实体...\n`);

  const allEntities = [];

  for (const guide of outline.guides) {
    // Build hierarchy text for LLM
    const hierarchyText = guide.hierarchy
      .map((h1) => {
        const subs = h1.children
          .map((h2) => {
            const subs3 = h2.children
              .map((h3) => `    - ${h3.title}`)
              .join("\n");
            return `  - ${h2.title}${subs3 ? "\n" + subs3 : ""}`;
          })
          .join("\n");
        return `- ${h1.title}${subs ? "\n" + subs : ""}`;
      })
      .join("\n");

    const keyParas = guide.keyParagraphs.slice(0, 5).join("\n");

    const prompt = `指南名称: ${guide.title}\n\n章节结构:\n${hierarchyText}\n\n关键段落:\n${keyParas}\n\n请提取以下实体关系：\n1. 该疾病的主要症状\n2. 推荐药物\n3. 诊断检查方法\n4. 危险因素\n5. 治疗方案`;

    try {
      const entities = await callLLM(prompt);
      // Attach source
      for (const e of entities) {
        if (!e.source) e.source = guide.title;
      }
      allEntities.push(...entities);
      console.log(`  ✅ ${guide.title} → ${entities.length} 条实体`);
    } catch (err) {
      console.error(`  ❌ ${guide.title} → ${err.message}`);
    }

    // Rate limiting: 短暂延迟避免触发限额
    await new Promise((r) => setTimeout(r, 500));
  }

  // 去重合并
  const unique = new Map();
  for (const e of allEntities) {
    const key = `${e.disease}|${e.entityType}|${e.entityName}|${e.relation}`;
    if (!unique.has(key)) {
      unique.set(key, e);
    }
  }

  // 统一口径：所有统计均基于去重后的实体集，确保 totalEntities == uniqueEntities == entities.length
  const uniqueEntities = Array.from(unique.values());

  const graph = {
    generatedAt: new Date().toISOString(),
    stats: {
      totalEntities: uniqueEntities.length,
      uniqueEntities: uniqueEntities.length,
      diseaseCount: new Set(uniqueEntities.map((e) => e.disease)).size,
      drugCount: uniqueEntities.filter((e) => e.entityType === "drug").length,
      symptomCount: uniqueEntities.filter((e) => e.entityType === "symptom").length,
      examCount: uniqueEntities.filter((e) => e.entityType === "examination").length,
    },
    entities: uniqueEntities,
  };

  await writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), "utf-8");

  console.log(`\n知识图谱已写入: ${GRAPH_FILE}`);
  console.log(`总计: ${graph.stats.uniqueEntities} 条唯一实体`);
  console.log(`  疾病: ${graph.stats.diseaseCount}`);
  console.log(`  药物: ${graph.stats.drugCount}`);
  console.log(`  症状: ${graph.stats.symptomCount}`);
  console.log(`  检查: ${graph.stats.examCount}`);
}

main().catch(console.error);
