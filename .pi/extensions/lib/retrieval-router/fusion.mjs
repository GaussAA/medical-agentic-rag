// retrieval-router/fusion.mjs — RRF 结果融合
//
// 内部委托给 pi-knowledge 的 reciprocalRankFusion + weightedScoreFusion，
// 保持对外接口 rrfFusion(lists, k, topK) 不变，新增 weightedFusion() 导出。
//
// 适配层：将项目的 { file_path, score, ... } 格式转换为 pi-knowledge 的
// { chunkId, score } 格式，统一切片后映射回原始条目。
//
// 使用 createRequire 而非动态 import() 以保持函数同步签名。

import { createRequire } from "node:module";

const RRF_K = 60;

// ── 惰性加载 pi-knowledge fusion 模块 ──
let _pkFusion = null;

function getPiFusion() {
  if (_pkFusion) return _pkFusion;
  try {
    const require = createRequire(import.meta.url);
    // pi-knowledge 安装在用户 HOME 的 .pi/agent/npm/ 下
    // 从 project node_modules 或 HOME node_modules 解析
    const pkgPath = require.resolve("pi-knowledge/dist/src/search/fusion.js", {
      paths: [
        process.cwd(),
        join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules"),
      ],
    });
    _pkFusion = require(pkgPath);
    if (typeof _pkFusion.reciprocalRankFusion !== "function") {
      _pkFusion = null;
      return null;
    }
    return _pkFusion;
  } catch {
    return null;
  }
}

import { join } from "node:path";

/**
 * 将项目格式的结果转换为 pi-knowledge 的 {chunkId, score} 格式。
 */
function toPiFormat(results) {
  if (!Array.isArray(results)) return [];
  return results.map((r) => ({
    chunkId: r.chunk_id || r.chunkId || r.file_path || "",
    score: typeof r.score === "number" ? r.score : 0,
  }));
}

/**
 * 从多路结果中构建 chunkId → 原始条目的映射表。
 */
function buildItemMap(lists) {
  const map = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const id = item.chunk_id || item.chunkId || item.file_path || "";
      if (id && !map.has(id)) map.set(id, item);
    }
  }
  return map;
}

/**
 * RRF 结果融合（内部委托给 pi-knowledge reciprocalRankFusion）。
 * 对外接口与旧版 rrfFusion(lists, k, topK) 完全兼容。
 *
 * @param {Array<Array>} lists 多路检索结果数组
 * @param {number} [k=60] RRF 常数
 * @param {number} [topK=8] 返回条数
 * @returns {Array} 融合后的结果（含 rrfScore 字段）
 */
export function rrfFusion(lists, k = RRF_K, topK = 8) {
  if (!Array.isArray(lists) || lists.length === 0) return [];
  if (lists.length === 1) return (lists[0] || []).slice(0, topK);

  // 尝试 pi-knowledge 版本
  const pk = getPiFusion();
  if (pk) {
    try {
      const itemMap = buildItemMap(lists);
      const piLists = lists.map((list) => toPiFormat(list));
      const fused = pk.reciprocalRankFusion(piLists, k);
      return fused.slice(0, topK).map((f) => {
        const original = itemMap.get(f.chunkId) || {};
        return { ...original, rrfScore: Number(f.score.toFixed(4)) };
      });
    } catch {
      /* 降级到手写 */
    }
  }

  // 回退：手写 RRF（与旧版一致）
  const fused = new Map();
  for (const list of lists) {
    if (!Array.isArray(list)) continue;
    for (let rank = 0; rank < list.length; rank++) {
      const item = list[rank];
      if (!item || !item.file_path) continue;
      const prev = fused.get(item.file_path);
      if (prev) { prev.score += 1 / (k + rank); if (item.score > (prev.item.score || 0)) prev.item = item; }
      else { fused.set(item.file_path, { score: 1 / (k + rank), item: { ...item } }); }
    }
  }
  return [...fused.values()].sort((a, b) => b.score - a.score).slice(0, topK).map((entry) => ({ ...entry.item, rrfScore: Number(entry.score.toFixed(4)) }));
}

/**
 * Weighted Score Fusion（新增，供 Hybrid 双通道使用）。
 * 对 BM25 和向量检索结果做加权融合。
 *
 * @param {Array} bm25Results BM25 检索结果
 * @param {Array} vectorResults 向量检索结果
 * @param {object} [weights] 权重 { bm25, vector, overlap }
 * @param {number} [topK=8] 返回条数
 * @returns {Array} 融合后的结果
 */
export function weightedFusion(bm25Results, vectorResults, weights = {}, topK = 8) {
  const pk = getPiFusion();
  if (pk && typeof pk.weightedScoreFusion === "function") {
    try {
      const bm25Pi = toPiFormat(bm25Results);
      const vecPi = toPiFormat(vectorResults);
      const itemMap = buildItemMap([bm25Results, vectorResults]);
      const fused = pk.weightedScoreFusion(bm25Pi, vecPi, weights);
      return fused.slice(0, topK).map((f) => {
        const original = itemMap.get(f.chunkId) || {};
        return { ...original, fusedScore: Number(f.score.toFixed(4)) };
      });
    } catch {
      /* 降级 */
    }
  }

  // 回退：取并集最高分
  const combined = [...(bm25Results || []), ...(vectorResults || [])];
  const best = new Map();
  for (const item of combined) {
    const key = item.chunk_id || item.chunkId || item.file_path || "";
    if (!key) continue;
    const existing = best.get(key);
    if (!existing || (item.score || 0) > (existing.score || 0)) best.set(key, item);
  }
  return [...best.values()].slice(0, topK);
}
