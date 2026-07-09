/**
 * pi-knowledge 中文重排序模型 patch 脚本（幂等）
 *
 * 将 pi-knowledge 默认英文重排序模型 ms-marco-MiniLM-L-4-v2 升级为
 * 中文 bge-reranker-base，并修正 sigmoid 饱和问题：
 *
 *   1. loadRerankerPipeline: 改用 AutoTokenizer + AutoModelForSequenceClassification
 *      （原 pipeline("text-classification") 对 logits 做 sigmoid，bge 的 logits
 *       普遍偏大导致饱和到 1.0，重排序失效）
 *   2. handleRerank: 改取 model 原始 logits 排序（区分度 16+ 单位）
 *   3. 增加 PI_KNOWLEDGE_RERANKER 环境变量支持（默认 bge-reranker-base）
 *
 * pi-knowledge 升级后需重新执行本脚本。
 *
 * 用法: node scripts/apply-reranker-patch.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";

const MODEL_WORKER_PATH = join(
  homedir(),
  ".pi",
  "agent",
  "npm",
  "node_modules",
  "pi-knowledge",
  "dist",
  "src",
  "model-worker.js"
);

const OLD_LOAD = `async function loadRerankerPipeline() {
    if (rerankerPipeline)
        return rerankerPipeline;
    const { pipeline, env } = await import("@huggingface/transformers");
    configureTransformersEnv(env);
    const createPipeline = pipeline;
    const loaded = (await createPipeline("text-classification", "Xenova/ms-marco-MiniLM-L-4-v2"));
    rerankerPipeline = loaded;
    return loaded;
}`;

const NEW_LOAD = `async function loadRerankerPipeline() {
    if (rerankerPipeline)
        return rerankerPipeline;
    const { AutoTokenizer, AutoModelForSequenceClassification, env } = await import("@huggingface/transformers");
    configureTransformersEnv(env);
    const rerankerModelName = process.env.PI_KNOWLEDGE_RERANKER ?? "Xenova/bge-reranker-base";
    const tokenizer = await AutoTokenizer.from_pretrained(rerankerModelName);
    const model = await AutoModelForSequenceClassification.from_pretrained(rerankerModelName);
    rerankerPipeline = { tokenizer, model };
    return rerankerPipeline;
}`;

const OLD_RERANK = `async function handleRerank(request) {
    const pipe = await loadRerankerPipeline();
    const results = [];
    for (const candidate of request.candidates) {
        const output = await pipe({ text: request.query, text_pair: candidate.content });
        const score = Array.isArray(output) ? (output[0]?.score ?? 0) : (output?.score ?? 0);
        results.push({ chunkId: candidate.chunkId, score });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, request.topK);
}`;

const NEW_RERANK = `async function handleRerank(request) {
    const { tokenizer, model } = await loadRerankerPipeline();
    const results = [];
    for (const candidate of request.candidates) {
        const inputs = tokenizer(request.query, { text_pair: candidate.content, padding: true, truncation: true });
        const { logits } = await model(inputs);
        results.push({ chunkId: candidate.chunkId, score: logits.data[0] });
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, request.topK);
}`;

async function main() {
  let src;
  try {
    src = await readFile(MODEL_WORKER_PATH, "utf-8");
  } catch {
    console.error(`[错误] 未找到 model-worker.js:`);
    console.error(`  ${MODEL_WORKER_PATH}`);
    console.error("请确认 pi-knowledge 已通过 pi install npm:pi-knowledge 安装");
    process.exit(1);
  }

  // 幂等检测：已含 AutoModelForSequenceClassification 则视为已 patch
  if (src.includes("AutoModelForSequenceClassification")) {
    console.log("[跳过] model-worker.js 已 patch（含 AutoModelForSequenceClassification）");
    return;
  }

  let patched = src;
  let applied = 0;

  if (patched.includes(OLD_LOAD)) {
    patched = patched.replace(OLD_LOAD, NEW_LOAD);
    applied++;
  } else {
    console.error("[警告] 未匹配到原始 loadRerankerPipeline，可能 pi-knowledge 版本已变更");
  }

  if (patched.includes(OLD_RERANK)) {
    patched = patched.replace(OLD_RERANK, NEW_RERANK);
    applied++;
  } else {
    console.error("[警告] 未匹配到原始 handleRerank，可能 pi-knowledge 版本已变更");
  }

  if (applied === 0) {
    console.error("[错误] 两个函数均未匹配，请手动检查 model-worker.js");
    process.exit(1);
  }

  await writeFile(MODEL_WORKER_PATH, patched, "utf-8");

  console.log(`[完成] 中文重排序 patch 已应用（${applied}/2 函数）`);
  console.log("  模型: Xenova/ms-marco-MiniLM-L-4-v2 (英文) → Xenova/bge-reranker-base (中文)");
  console.log("  打分: sigmoid score (饱和) → raw logits (区分度 16+)");
  console.log("  新增环境变量: PI_KNOWLEDGE_RERANKER (可覆盖默认模型)");
  console.log(`  文件: ${MODEL_WORKER_PATH}`);
  console.log("");
  console.log("提示: pi-knowledge 升级后请重新执行本脚本");
}

main().catch((err) => {
  console.error("patch 异常:", err);
  process.exit(1);
});
