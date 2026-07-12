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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// ---- 解析 pi-knowledge 内部模块路径（与 retrieval-router 同范式，环境变量化）----
// 版本探测：同时探测两种内部布局（dist/src/<sub> 与 dist/<sub>），
// 兼容 pi-knowledge 升级时的内部路径调整，避免「升级即断」。
export function npmRoots() {
  const roots = [];
  if (process.env.PI_AGENT_NPM) roots.push(process.env.PI_AGENT_NPM);
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) roots.push(join(home, ".pi", "agent", "npm"));
  return roots.filter(Boolean);
}
export function candidates(sub) {
  const layouts = ["dist/src", "dist"];
  const out = [];
  for (const root of npmRoots()) {
    for (const layout of layouts) {
      out.push(join(root, "node_modules", "pi-knowledge", layout, sub));
    }
  }
  return out;
}
export function getEngineVersion() {
  for (const root of npmRoots()) {
    const pkg = join(root, "node_modules", "pi-knowledge", "package.json");
    if (existsSync(pkg)) {
      try {
        return JSON.parse(readFileSync(pkg, "utf-8")).version || null;
      } catch {
        /* 解析失败忽略 */
      }
    }
  }
  return null;
}
function findModule(sub) {
  for (const c of candidates(sub)) if (existsSync(c)) return c;
  return null;
}

/**
 * 引擎 API 兼容性断言（版本探测核心）。
 * pi-knowledge 升级可能改动内部接口（构造器名 / search·initialize 方法 / 响应结构），
 * 此处显式校验预期 API 面，缺失即抛清晰错误 → 调用方优雅降级 BM25 并告警。
 * @param {object} engineMod 已 import 的引擎模块
 */
export function validateEngineApi(engineMod) {
  if (!engineMod || typeof engineMod.KnowledgeEngine !== "function") {
    throw new Error("引擎 API 不兼容：未导出 KnowledgeEngine 构造器（可能 pi-knowledge 已升级内部接口）");
  }
  const proto = engineMod.KnowledgeEngine.prototype || {};
  if (typeof proto.search !== "function" || typeof proto.initialize !== "function") {
    throw new Error("引擎 API 不兼容：KnowledgeEngine 缺失 search/initialize 方法，可能 pi-knowledge 已升级接口");
  }
  return true;
}

let _modulePromise = null;
function loadEngineModule() {
  if (_modulePromise) return _modulePromise;
  _modulePromise = (async () => {
    const eng = findModule("engine.js");
    const sto = findModule("storage/sqlite.js");
    if (!eng) throw new Error("pi-knowledge 引擎模块不可达（确认 pi-knowledge@0.5.1 已安装）");
    const engineMod = await import(pathToFileURL(eng).href);
    validateEngineApi(engineMod); // 版本探测：API 面不兼容立即抛清晰错误
    const ver = getEngineVersion();
    if (ver) console.info(`[engine] pi-knowledge 版本探测：${ver}`);
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
    if (!resp || !Array.isArray(resp.results)) {
      return { ok: false, error: "引擎响应格式不兼容（缺失 results 数组），可能 pi-knowledge 已升级响应结构" };
    }

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
