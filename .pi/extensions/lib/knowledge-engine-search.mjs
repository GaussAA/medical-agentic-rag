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
import { logEngineFallback } from "./observability.mjs";
import { diag } from "./diagnostic-log.mjs";

// ---- 解析 pi-knowledge 内部模块路径（与 retrieval-router 同范式，环境变量化）----
// 版本探测：同时探测两种内部布局（dist/src/<sub> 与 dist/<sub>），
// 兼容 pi-knowledge 升级时的内部路径调整，避免「升级即断」。
export function npmRoots() {
  const roots = [];
  if (process.env.PI_AGENT_NPM) roots.push(process.env.PI_AGENT_NPM);
  // 优先从项目 .pi/npm/ 查找（项目级隔离安装）
  const projectNpm = join(process.cwd(), ".pi", "npm");
  if (existsSync(projectNpm)) roots.push(projectNpm);
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
    if (ver) diag.info("engine", "pi-knowledge 版本探测：" + ver);
    let dir;
    if (sto) {
      try {
        const stoMod = await import(pathToFileURL(sto).href);
        if (typeof stoMod.getDefaultKnowledgeDir === "function") {
          dir = stoMod.getDefaultKnowledgeDir();
        }
      } catch {
        dir = null;
      }
    }
    // 多级 fallback：PI_KNOWLEDGE_DIR → 项目 .pi/knowledge/ → 用户 HOME .pi/knowledge
    if (!dir) {
      dir = process.env.PI_KNOWLEDGE_DIR?.trim()
        || join(process.cwd(), ".pi", "knowledge")
        || join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "knowledge");
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
  // 初始化失败后清空Promise，避免永久缓存拒绝态，下次可重试；同时留痕便于诊断引擎不可用
  _initPromise.catch((e) => {
    _initPromise = null;
    diag.error(
      "knowledge-engine",
      "引擎懒加载失败，后续检索将回退 BM25: " + (e?.message || e),
    );
    // 观测：引擎回退信号落盘（不止 stderr），脆弱点可见化
    logEngineFallback({ reason: "lazy_init_failed:" + (e?.message || e) }).catch(() => {});
  });
  return _initPromise;
}

// ---- 健壮性常量（env 可调，跨机可移植）----
// 引擎检索超时(ms)：超时即熔断回退 BM25，根治 dense 引擎卡死（P0-3，会话实测单次 665s≈11min）。
export const ENGINE_TIMEOUT_MS = Number(process.env.ENGINE_TIMEOUT_MS) || 20000;
// 软约束采信比例：过滤集最高分 ≥ 全库最高分 × 此比例 时才采信路由约束，
// 否则判定路由失准（约束砍掉了更相关文件），回退全库不过滤（P0-2）。
export const SOFT_CONSTRAINT_RATIO = Number(process.env.SOFT_CONSTRAINT_RATIO) || 0.6;

/**
 * 软约束兜底（P0-2 根治「约束锁死错文件」）。
 * 原逻辑对引擎结果按路由命中文件做**硬过滤**：路由一旦失准，正确文件被一刀砍，
 * 只剩错文件低分碎片（会话实测 score 仅 0.4–1.3）。改为软约束：
 *   · 过滤集为空 → 直接回退全库（绝不返回空，除非全库本就空）；
 *   · 过滤集最高分 < 全库最高分 × ratio → 判定路由把更相关文件砍掉了 → 回退全库；
 *   · 否则采信过滤集（保留「防真指南被压沉」的原意）。
 * 纯函数，无需真引擎即可单测。
 * @param {Array} results 引擎原始结果（含 score/file_path）
 * @param {Array<string>|null} routedFilePaths 路由命中文件路径
 * @param {object} [opts] { ratio=SOFT_CONSTRAINT_RATIO }
 * @returns {{results:Array, constraintApplied:boolean}}
 */
export function applySoftConstraint(results, routedFilePaths, opts = {}) {
  const ratio = typeof opts.ratio === "number" ? opts.ratio : SOFT_CONSTRAINT_RATIO;
  if (!Array.isArray(results) || !results.length) {
    return { results: Array.isArray(results) ? results : [], constraintApplied: false };
  }
  if (!routedFilePaths || !routedFilePaths.length) {
    return { results, constraintApplied: false };
  }
  const set = new Set(routedFilePaths);
  const scoreOf = (r) => (typeof r?.score === "number" ? r.score : 0);
  const filtered = results.filter((r) => set.has(r.file_path));
  if (!filtered.length) {
    return { results, constraintApplied: false }; // 过滤集空 → 回退全库
  }
  const fullTop = Math.max(...results.map(scoreOf));
  const filtTop = Math.max(...filtered.map(scoreOf));
  // fullTop<=0：全库无有效分数信号，保守采信过滤集（退化保护，避免误判）
  if (fullTop <= 0 || filtTop >= fullTop * ratio) {
    return { results: filtered, constraintApplied: true };
  }
  return { results, constraintApplied: false }; // 约束砍掉了更相关文件 → 回退全库
}

/**
 * 引擎检索超时熔断（P0-3 根治「665s 卡死无兜底」）。
 * Promise.race 竞速：超时即抛 Error("ENGINE_TIMEOUT")，调用方回退 BM25 秒回，
 * 不再干等。同时合并外部 signal 与 AbortSignal.timeout，best-effort 通知引擎中断。
 * 纯函数，可注入 mock 引擎单测（无需真 e5/rerank）。
 * @param {{search:Function}} engine
 * @param {string} query
 * @param {object} searchOpts 透传引擎 search 的第二参
 * @param {AbortSignal|null} externalSignal 外部取消信号
 * @param {number} [timeoutMs=ENGINE_TIMEOUT_MS]
 * @returns {Promise<any>} 引擎响应；超时抛 Error("ENGINE_TIMEOUT")
 */
export async function searchWithTimeout(engine, query, searchOpts, externalSignal, timeoutMs = ENGINE_TIMEOUT_MS) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const mergedSignal = externalSignal ? AbortSignal.any([externalSignal, timeoutSignal]) : timeoutSignal;
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("ENGINE_TIMEOUT")), timeoutMs);
    if (timer && typeof timer.unref === "function") timer.unref(); // 不阻止进程自然退出
  });
  try {
    return await Promise.race([engine.search(query, searchOpts, mergedSignal), timeoutPromise]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 调用内置引擎做 hybrid / semantic / deep(重排) 检索。
 * @param {string} query
 * @param {object} [opts] { mode='hybrid', limit=8, kbId=null, routedFilePaths=null, offset=0, diversity='balanced', signal=null }
 * @returns {Promise<{ok:true, results:Array, modeUsed:string, totalCount:number, latencyMs:number, constraintApplied:boolean}
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
    let resp;
    try {
      // 超时熔断（P0-3）：Promise.race 竞速，>ENGINE_TIMEOUT_MS 即抛 ENGINE_TIMEOUT
      resp = await searchWithTimeout(
        engine,
        query,
        { mode, limit: fetchLimit, offset, kb_id: kbId || undefined, diversity },
        signal,
        ENGINE_TIMEOUT_MS,
      );
    } catch (e) {
      if (e && e.message === "ENGINE_TIMEOUT") {
        const latencyMs = Date.now() - t0;
        diag.warn("knowledge-engine", `引擎检索超时(>${ENGINE_TIMEOUT_MS}ms)，熔断回退 BM25`);
        // 观测：超时熔断落盘（reason 内联实测延迟，logEngineFallback 仅取 reason 字段）
        logEngineFallback({ reason: `engine_timeout:${ENGINE_TIMEOUT_MS}ms@${latencyMs}ms` }).catch(() => {});
        return { ok: false, error: `引擎检索超时(>${ENGINE_TIMEOUT_MS}ms)，已熔断回退 BM25` };
      }
      throw e; // 其他异常交由外层 catch 统一处理
    }
    const latencyMs = Date.now() - t0;
    if (!resp || !Array.isArray(resp.results)) {
      return { ok: false, error: "引擎响应格式不兼容（缺失 results 数组），可能 pi-knowledge 已升级响应结构" };
    }

    // 软约束兜底（P0-2）：路由失准时回退全库，不再硬过滤砍掉正确文件
    const { results: constrained, constraintApplied } = applySoftConstraint(resp.results || [], routedFilePaths);
    if (routedFilePaths && routedFilePaths.length && !constraintApplied) {
      // 观测：路由约束被软兜底放弃（路由失准信号，可见化便于路由层复盘）
      diag.info("knowledge-engine", "路由约束未采信（过滤集空或分数显著偏低），已回退全库");
    }
    const results = constrained.slice(0, limit).map((r) => ({
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
      constraintApplied,
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
