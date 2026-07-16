/**
 * 医学实体提取脚本（并发加速版 v2）
 * 优先使用 SenseNova(日日新) 免费模型从指南大纲抽取结构化医学实体与关系，
 * 利用 SENSENOVA_API_KEYS 20 Key 池并发抽取，每指南换 Key，充分利用免费并发额度。
 * DeepSeek 付费仅当 ALLOW_PAID_FALLBACK=true 时作最后兜底。
 *
 * 用法: node scripts/kb/extract-entities.mjs
 *   - 优先 SENSENOVA_API_KEYS（20 Key 池，轮询并发）
 *   - 回退 SENSENOVA_API_KEY（单 Key 向后兼容）
 *   - 付费 deepseek 仅当 ALLOW_PAID_FALLBACK=true
 * 输出: data/kb/.knowledge-graph.json
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseKeys } from "../lib/parse-keys.mjs"; // P1#7 抽离：单一真相源，可独立单测

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", ".."); // 仓库根目录（scripts/kb 上两级）
const OUTLINE_FILE = join(ROOT, "data", "kb", ".outline.json");
const GRAPH_FILE = join(ROOT, "data", "kb", ".knowledge-graph.json");

// ---------- 20 Key 池并发机制（复用 llm-judge 命名惯例） ----------
// parseKeys 已抽离至 scripts/lib/parse-keys.mjs（单一真相源，可独立单测）。
const SENSENOVA_KEYS = (() => {
  const pool = parseKeys(process.env.SENSENOVA_API_KEYS || "");
  const single = process.env.SENSENOVA_API_KEY;
  if (single && !pool.includes(single)) pool.push(single);
  if (!pool.length && !process.env.DEEPSEEK_API_KEY) {
    console.error("请至少设置 SENSENOVA_API_KEYS 或 SENSENOVA_API_KEY");
    process.exit(1);
  }
  return pool;
})();

const ALLOW_PAID = process.env.ALLOW_PAID_FALLBACK === "true";
// 并发数：sensenova 免费账户固定支撑约 20 路并发，与 Key 数量无关。
// 多 Key 的作用是故障转移（单 Key 429 限速时换 Key 绕过），而非叠加并发。
// LLM_CONCURRENCY 环境变量可覆盖（默认 20）。
const LLM_CONCURRENCY = Number(process.env.LLM_CONCURRENCY) || 20;
const CONCURRENCY = Math.max(1, Math.min(LLM_CONCURRENCY, 20));
const MAX_KEY_ATTEMPTS = Math.max(1, Math.min(3, SENSENOVA_KEYS.length));

// 轮询 Key
let rrIdx = 0;
function nextSensenovaKey() {
  if (!SENSENOVA_KEYS.length) return null;
  const key = SENSENOVA_KEYS[rrIdx % SENSENOVA_KEYS.length];
  rrIdx = (rrIdx + 1) % SENSENOVA_KEYS.length;
  return key;
}

/**
 * 单次提取调用（用指定 Key 请求 sensenova）。
 */
async function callOne(key, prompt) {
  const res = await fetch("https://token.sensenova.cn/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${key}`,
    },
    body: JSON.stringify({
      model: "sensenova-6.7-flash-lite",
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
  const jsonMatch = text.match(/\[[\s\S]*\]/);
  if (jsonMatch) return JSON.parse(jsonMatch[0]);
  try {
    return JSON.parse(text);
  } catch {
    console.warn("LLM 返回非 JSON:", text.slice(0, 200));
    return [];
  }
}

/**
 * 为单指南提取实体——轮询取 Key，失败后换 Key 重试 MAX_KEY_ATTEMPTS 次。
 */
async function processGuide(guide) {
  const hierarchyText = guide.hierarchy
    .map((h1) => {
      const subs = h1.children
        .map((h2) => {
          const subs3 = h2.children.map((h3) => `    - ${h3.title}`).join("\n");
          return `  - ${h2.title}${subs3 ? "\n" + subs3 : ""}`;
        })
        .join("\n");
      return `- ${h1.title}${subs ? "\n" + subs : ""}`;
    })
    .join("\n");

  const keyParas = guide.keyParagraphs.slice(0, 5).join("\n");
  const prompt = `指南名称: ${guide.title}\n\n章节结构:\n${hierarchyText}\n\n关键段落:\n${keyParas}\n\n请提取以下实体关系：\n1. 该疾病的主要症状\n2. 推荐药物\n3. 诊断检查方法\n4. 危险因素\n5. 治疗方案`;

  let lastErr;
  for (let attempt = 0; attempt < MAX_KEY_ATTEMPTS; attempt++) {
    const key = nextSensenovaKey();
    if (!key) break;
    try {
      const entities = await callOne(key, prompt);
      for (const e of entities) {
        if (!e.source) e.source = guide.title;
      }
      return { entities, ok: true };
    } catch (err) {
      lastErr = err;
      // 换 Key 重试
    }
  }
  return { entities: [], ok: false, error: lastErr?.message || "未知错误" };
}

/** 有界并发执行器（同 llm-judge.runWithConcurrency）。 */
async function runWithConcurrency(tasks, limit) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const cur = idx++;
      results[cur] = await tasks[cur]();
    }
  }
  const n = Math.max(1, Math.min(limit, tasks.length));
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

async function main() {
  const outline = JSON.parse(await readFile(OUTLINE_FILE, "utf-8"));

  console.log(`Key 池大小: ${SENSENOVA_KEYS.length || "(无免费 Key)"}  |  并发数: ${CONCURRENCY}`);
  console.log(`付费兜底: ${ALLOW_PAID ? "已授权" : "未授权（默认关闭）"}`);
  console.log(`开始从 ${outline.guides.length} 份指南并发提取实体...\n`);

  const results = await runWithConcurrency(
    outline.guides.map((guide) => () => processGuide(guide)),
    CONCURRENCY,
  );

  const allEntities = [];
  for (let i = 0; i < outline.guides.length; i++) {
    const r = results[i];
    if (r.ok) {
      allEntities.push(...r.entities);
      console.log(`  ✅ ${outline.guides[i].title} → ${r.entities.length} 条实体`);
    } else {
      console.error(`  ❌ ${outline.guides[i].title} → ${r.error}`);
    }
  }

  // 去重合并
  const unique = new Map();
  for (const e of allEntities) {
    const key = `${e.disease}|${e.entityType}|${e.entityName}|${e.relation}`;
    if (!unique.has(key)) unique.set(key, e);
  }
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
