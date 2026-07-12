// .pi/extensions/lib/knowledge-engine-search.mjs
//
// 复用 pi-knowledge 内置 KnowledgeEngine 实现「真 hybrid + 重排」（内置优先 / DRY），
// 取代 rag_search 当年为「路由约束防真指南被压沉」而手搓的纯 BM25 路径。
//
// 设计纪律（契合项目原则）：
//   · 内置优先：直接复用 pi-knowledge 的引擎与已建的 e5 稠密向量（vectors/<kb_id>.bin），
//     不重嵌、不手搓向量/重排。
//   · 显式错误捕获 + 无静默失败：引擎 import / 初始化 / 检索任一环节失败，
//     返回 {ok:false, error}，由调用方退回既有 BM25（searchKnowledge）并显式告警。
//   · 双可测：纯 .mjs，既能被 .ts 扩展经 jiti 加载，也能被原生 node 脚本单测。
//   · 路径解析沿用 retrieval-router 解析 better-sqlite3 的候选路径范式，不硬编码密钥/绝对路径。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---- 解析 pi-knowledge 内部模块路径（与 retrieval-router 同范式）----
function candidates(sub) {
  return [
    join(process.env.PI_AGENT_NPM || "", "node_modules", "pi-knowledge", "dist", "src", sub),
    "C:/Users/JaNiy/.pi/agent/npm/node_modules/pi-knowledge/dist/src/" + sub,
    join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules", "pi-knowledge", "dist", "src", sub),
  ].filter(Boolean);
}
function findModule(sub) {
  for (const c of candidates(sub)) if (existsSync(c)) return c;
  return null;
}

let _modulePromise = null;
function loadEngineModule() {
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    const eng = findModule("engine.js");
    const sto = findModule("storage/sqlite.js");
    if (!eng) throw new Error("pi-knowledge 引擎模块不可达（确认 pi-knowledge@0.5.1 已安装）");
    const engineMod = await import(pathToFileURL(eng).href);
    if (!engineMod.KnowledgeEngine) throw new Error("engine 模块未导出 KnowledgeEngine");
    let dir;
    if (sto) {
      try {
        const stoMod = await import(pathToFileURL(sto).href);
        dir = stoMod.getDefaultKnowledgeDir();
      } catch {
        dir = join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "knowledge");
      }
    } else {
      dir = join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "knowledge");
    }
    return { engineMod, dir };
  })();
  return _modulePromise;
}

let _engine = null;
let _initPromise = null;
async function getEngine() {
  if (_engine) return _engine;
  if (_initPromise) return _initPromise;
  _initPromise = (async () => {
    const { engineMod, dir } = await loadEngineModule();
    const engine = new engineMod.KnowledgeEngine();
    await engine.initialize(dir); // 首次搜索时懒加载 e5（秒级，会话内缓存）
    _engine = engine;
    return engine;
  })();
  // 初始化失败后清空Promise，避免永久缓存拒绝态，下次可重试
  _initPromise.catch(() => {
    _initPromise = null;
  });
  return _initPromise;
}

/**
 * 调用内置引擎做 hybrid / semantic / deep(重排) 检索。
 * @param {string} query
 * @param {object} [opts] { mode='hybrid', limit=8, kbId=null, routedFilePaths=null, offset=0, diversity='balanced', signal=null }
 * @returns {Promise<{ok:true, results:Array, modeUsed:string, totalCount:number, latencyMs:number}
 *                  |{ok:false, error:string}>}
 */
export async function engineHybridSearch(query, opts = {}) {
  const {
    mode = "hybrid",
    limit = 8,
    kbId = null,
    routedFilePaths = null,
    offset = 0,
    diversity = "balanced",
    signal = null,
  } = opts;

  let engine;
  try {
    engine = await getEngine();
  } catch (e) {
    return { ok: false, error: "引擎初始化失败：" + (e?.message || String(e)) };
  }

  try {
    // 路由约束时多取候选，过滤后仍有余量；未路由则按请求数取
    const fetchLimit = routedFilePaths && routedFilePaths.length ? Math.max(limit * 3, 20) : limit;
    const t0 = Date.now();
    const resp = await engine.search(
      query,
      {
        mode,
        limit: fetchLimit,
        offset,
        kb_id: kbId || undefined,
        diversity,
      },
      signal,
    );
    const latencyMs = Date.now() - t0;

    let results = resp.results || [];
    // 路由约束：仅保留命中的指南文件（与原 BM25 约束语义一致；未路由则不过滤）
    if (routedFilePaths && routedFilePaths.length) {
      const set = new Set(routedFilePaths);
      results = results.filter((r) => set.has(r.file_path));
    }
    results = results.slice(0, limit).map((r) => ({
      file_path: r.file_path,
      score: typeof r.score === "number" ? Number(r.score.toFixed(3)) : 0,
      snippet: r.snippet || "",
      chunk_id: r.provenance?.chunk_id || null, // 供引文锚定 / 溯源 / 观测
      metadata: r.provenance || null,
    }));
    return {
      ok: true,
      results,
      modeUsed: resp.mode_used || mode,
      totalCount: resp.total_count || results.length,
      latencyMs,
    };
  } catch (e) {
    return { ok: false, error: "引擎检索失败：" + (e?.message || String(e)) };
  }
}

/** 探测：内置引擎是否可用（启动期 / 测试用，不抛异常）。 */
export async function isEngineAvailable() {
  try {
    await getEngine();
    return true;
  } catch {
    return false;
  }
}
