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
 * ⚠️ 技术债声明：本脚本通过字符串替换直接修改 pi-knowledge 的 dist 源码，
 *    属对第三方包的侵入式补丁。pi-knowledge 一旦原生支持中文 reranker 配置
 *    （如官方暴露 reranker 模型选择项），本脚本应立即弃用。当前为保中文重排
 *    质量不得已而为之，并以版本锁(.pi/reranker-patch.lock.json)在升级时告警。
 *
 * 📨 上游诉求已起草：docs/pi-knowledge-upstream-issue.md（向 nczz/pi-knowledge
 *    提 issue，建议暴露 PI_KNOWLEDGE_RERANKER 环境变量 + 对 cross-encoder 取
 *    raw logits）。上游合入后，本补丁删除，改由 start 脚本注入环境变量即可。
 *
 * 用法: node scripts/apply-reranker-patch.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { readFileSync, writeFileSync } from "node:fs";
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

const PKG_PATH = join(homedir(), ".pi", "agent", "npm", "node_modules", "pi-knowledge", "package.json");
const LOCK_PATH = join(homedir(), ".pi", "reranker-patch.lock.json");

function getPiKnowledgeVersion() {
  try {
    return JSON.parse(readFileSync(PKG_PATH, "utf-8")).version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function readPatchLock() {
  try {
    return JSON.parse(readFileSync(LOCK_PATH, "utf-8"));
  } catch {
    return null;
  }
}

function writePatchLock(version) {
  try {
    writeFileSync(LOCK_PATH, JSON.stringify({ version, patchedAt: new Date().toISOString() }, null, 2), "utf-8");
  } catch {
    // 锁文件仅用于升级告警，写入失败不影响补丁本身
  }
}

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

  // 版本锁：pi-knowledge 升级后补丁可能失效，给出显性告警
  const pkVersion = getPiKnowledgeVersion();
  const lock = readPatchLock();
  if (lock && pkVersion !== "unknown" && lock.version !== pkVersion) {
    console.warn(`\n[⚠️ 升级告警] pi-knowledge 已从 ${lock.version} 升级到 ${pkVersion}。`);
    console.warn("  补丁基于旧版函数签名，可能已失效。请复核下方匹配结果；");
    console.warn("  若两函数均未匹配，须手动适配或等待上游支持中文 reranker。\n");
  }

  // 幂等检测：已含 AutoModelForSequenceClassification 则视为已 patch
  if (src.includes("AutoModelForSequenceClassification")) {
    console.log("[跳过] model-worker.js 已 patch（含 AutoModelForSequenceClassification）");
    writePatchLock(pkVersion);
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
  writePatchLock(pkVersion);

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
