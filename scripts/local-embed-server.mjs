// scripts/local-embed-server.mjs
// 本地嵌入服务：OpenAI 兼容 /v1/embeddings，复用 Xenova/multilingual-e5-small（384 维）
// 供 llm-wiki 混合语义召回（embeddingProvider=local）使用，零 API 成本。
//
// 用法：node scripts/local-embed-server.mjs [--port 18881]
// 端点：
//   POST /v1/embeddings  { input: string | string[], model?: string } → OpenAI 兼容响应
//   GET  /health         { status, model, dim, cached }
//   GET  /v1/models      { object:"list", data:[{id, object:"model"}] }
//
// 依赖：@huggingface/transformers（.pi/npm/node_modules 内已有 3.8.1）
// 首次运行自动下载 Xenova/multilingual-e5-small（~90MB，走 HTTPS_PROXY 代理）。

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = parseInt(process.argv.find((a) => a.startsWith("--port="))?.split("=")[1] || process.env.EMBED_PORT || "18881", 10);

// 复用 .pi/npm 内的 transformers（与 pi-knowledge 同源）
const transformers = await import(join(ROOT, ".pi", "npm", "node_modules", "@huggingface", "transformers", "dist", "transformers.min.mjs"))
  .catch(async () => await import("@huggingface/transformers"));

const MODEL_ID = process.env.EMBED_MODEL || "Xenova/multilingual-e5-small";
const DIM = parseInt(process.env.EMBED_DIM || "384", 10);
const CACHE = new Map(); // text → vector

let pipe = null;
async function getPipeline() {
  if (pipe) return pipe;
  const { pipeline, env } = transformers;
  // 走系统代理下载模型（undici 不读 HTTP_PROXY，这里用 transformers 自带 env 配置）
  env.allowRemoteModels = true;
  env.allowLocalModels = true;
  const loaded = await pipeline("feature-extraction", MODEL_ID, {
    quantized: true,
    dtype: "fp32",
  });
  pipe = loaded;
  return loaded;
}

function l2Normalize(v) {
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0)) || 1;
  return v.map((x) => x / norm);
}

async function embedOne(text, isQuery = false) {
  const key = (isQuery ? "q:" : "p:") + text;
  if (CACHE.has(key)) return CACHE.get(key);
  const p = await getPipeline();
  // e5 系模型规范：查询加 "query: "、文档加 "passage: " 前缀。
  // 实测对照（中文）：无前缀 糖vs胃=0.847 / query: 0.844 / passage: 0.915 ——
  // query: 前缀区分度最佳。llm-wiki 的页面向量与查询向量均由本服务生成且做余弦比对，
  // 两侧必须同前缀一致（文档/查询不做区分），故统一 "query: " 前缀。
  const prefixed = `query: ${text}`;
  const output = await p(prefixed, { pooling: "mean", normalize: false });
  const vec = l2Normalize(Array.from(output.data));
  if (CACHE.size > 100000) CACHE.clear(); // 防内存膨胀
  CACHE.set(key, vec);
  return vec;
}

function toOpenAIChatRes(vectors, model) {
  return {
    object: "list",
    data: vectors.map((v, i) => ({
      object: "embedding",
      index: i,
      embedding: v,
    })),
    model,
    usage: { prompt_tokens: 0, total_tokens: 0 },
  };
}

const server = createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); return res.end(); }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  try {
    // /health
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ status: "ok", model: MODEL_ID, dim: DIM, cached: CACHE.size, pipeReady: !!pipe }));
    }
    // /v1/models
    if (req.method === "GET" && (url.pathname === "/v1/models" || url.pathname === "/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: [{ id: MODEL_ID, object: "model" }] }));
    }
    // /v1/embeddings
    if (req.method === "POST" && (url.pathname === "/v1/embeddings" || url.pathname === "/embeddings")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");
      const input = payload.input;
      if (!input) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "missing input" } })); }
      const items = Array.isArray(input) ? input : [input];
      if (items.length > 512) { res.writeHead(400, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ error: { message: "max 512 inputs per call" } })); }
      // 限并发 8 逐条嵌入，防本地模型过载/OOM（transformers.js 单条推理已内部并行）
      const CONC = 8;
      const vectors = [];
      for (let i = 0; i < items.length; i += CONC) {
        const chunk = items.slice(i, i + CONC);
        const chunkVecs = await Promise.all(chunk.map((t) => embedOne(String(t).slice(0, 8000), true)));
        vectors.push(...chunkVecs);
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(toOpenAIChatRes(vectors, payload.model || MODEL_ID)));
    }
    res.writeHead(404, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: "not found" } }));
  } catch (e) {
    res.writeHead(500, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ error: { message: e?.message || String(e) } }));
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[local-embed] 嵌入服务就绪 http://127.0.0.1:${PORT} (model=${MODEL_ID}, dim=${DIM})`);
});
