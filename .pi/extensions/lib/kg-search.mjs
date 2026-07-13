// kg-search.mjs
// 医疗知识图谱检索纯函数：按疾病/实体类型/关系过滤扁平实体表，并支持多跳图推理。
//
// 抽取自原 kg-search-tool.ts，逻辑保持一致；新增文件化缓存，降低重复查询开销。
// 多跳推理（searchKGDeep）由 kg-graph-db.mjs 提供 SQLite 递归 CTE 支撑，零新增基础设施。
// 纯 JavaScript（.mjs），供 kg-search-tool.ts（经 jiti）与 tests/unit/eval-bench.mjs（原生 node）共用。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheGet, cacheSet } from "./retrieval-cache.mjs";
import { traverseGraph, ensureGraphDb, graphDbPath, graphJsonPath } from "./kg-graph-db.mjs";

const ENTITY_LABEL = {
  drug: "药物",
  symptom: "症状",
  examination: "检查",
  riskFactor: "危险因素",
  treatment: "治疗",
};

/** 读取知识图谱实体（默认项目根下的 knowledge-base/.knowledge-graph.json）。 */
export function loadGraph(baseDir = process.cwd()) {
  const p = join(baseDir, "knowledge-base", ".knowledge-graph.json");
  const data = JSON.parse(readFileSync(p, "utf-8"));
  return data.entities || [];
}

/**
 * 检索知识图谱。
 * @param {object} params
 * @param {string} [params.disease] 疾病名称（模糊匹配）
 * @param {string} [params.entityType] 实体类型 drug/symptom/examination/riskFactor/treatment
 * @param {string} [params.relation] 关系类型 treated_with/has_symptom/diagnosed_by/has_risk/treated_by
 * @param {object} [opts]
 * @param {Array} [opts.graph] 预加载的实体数组
 * @param {boolean} [opts.useCache=true] 是否启用缓存
 * @param {string} [opts.baseDir] 图谱基目录
 * @returns {{query:object,text:string,count:number}}
 */
export function searchKG(params = {}, opts = {}) {
  const { graph, useCache = true, baseDir } = opts;
  const g = graph || loadGraph(baseDir);
  const cacheKey = `kg:${JSON.stringify(params)}`;

  if (useCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  let results = [...g];

  if (params.disease) {
    const kw = params.disease.toLowerCase();
    results = results.filter((e) =>
      (e.disease || "").toLowerCase().includes(kw),
    );
  }
  if (params.entityType) {
    results = results.filter((e) => e.entityType === params.entityType);
  }
  if (params.relation) {
    results = results.filter((e) => e.relation === params.relation);
  }

  // 去重并截断
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const key = `${r.disease}|${r.entityName}|${r.entityType}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(r);
      if (deduped.length >= 30) break;
    }
  }

  let output = `知识图谱查询结果（${deduped.length} 条）:\n\n`;
  if (deduped.length === 0) {
    output = `未找到与"${params.disease || ""}"相关的知识图谱条目。`;
  } else {
    const grouped = {};
    for (const r of deduped) {
      const disease = r.disease || "未知";
      (grouped[disease] ||= []).push(r);
    }
    for (const [disease, items] of Object.entries(grouped)) {
      output += `【${disease}】\n`;
      const byType = {};
      for (const item of items) {
        const type = item.entityType || "other";
        (byType[type] ||= []).push(item.entityName);
      }
      for (const [type, names] of Object.entries(byType)) {
        const label = ENTITY_LABEL[type] || type;
        output += `  ${label}: ${[...new Set(names)].join("、")}\n`;
      }
      output += `  来源: ${items[0].source || "未知"}\n\n`;
    }
  }

  const result = {
    query: params,
    text: output,
    count: deduped.length,
    cached: false,
  };
  if (useCache) cacheSet(cacheKey, result);
  return result;
}

/**
 * 多跳图推理检索：在「疾病 ↔ 实体」二分图上递归游走，发现间接关联。
 * 例如「高血压 → treated_with → 氨氯地平 → treated_with(反向) → 冠心病」，
 * 揭示某药物被哪些其他疾病共用（共病/共用药网络）。
 *
 * 依赖图谱 SQLite（由 scripts/kb/build-kg-db.mjs 构建）。若 DB 未就绪，优雅降级为提示。
 *
 * @param {object} params
 * @param {string} params.start 起始实体或疾病名（精确匹配）
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=2] 最大跳数
 * @param {number} [opts.limit=60] 返回路径上限
 * @param {boolean} [opts.useCache=true] 是否命中缓存
 * @param {string} [opts.baseDir] 图谱基目录
 * @returns {{query:object, text:string, count:number, cached?:boolean, degraded?:boolean}}
 */
export function searchKGDeep(params = {}, opts = {}) {
  const { start } = params;
  const { maxDepth = 2, limit = 60, useCache = true, baseDir } = opts;
  if (!start || !start.trim()) {
    return { query: params, text: "请提供多跳推理的起始实体或疾病名（start）。", count: 0 };
  }
  const cacheKey = `kgdeep:${start}|${maxDepth}|${limit}`;
  if (useCache) {
    const hit = cacheGet(cacheKey);
    if (hit) return { ...hit, cached: true };
  }

  const dbPath = graphDbPath(baseDir || process.cwd());
  if (!existsSync(dbPath)) {
    // 优雅降级：尝试即时构建（需 better-sqlite3 可用），否则提示
    const jsonPath = graphJsonPath(baseDir || process.cwd());
    if (existsSync(jsonPath)) {
      try {
        ensureGraphDb({ jsonPath, dbPath });
      } catch {
        return {
          query: params,
          text: "图谱索引未就绪（无法构建 SQLite），请运行 `node scripts/kb/build-kg-db.mjs`。",
          count: 0,
          degraded: true,
        };
      }
    } else {
      return {
        query: params,
        text: "图谱数据缺失，无法执行多跳推理。",
        count: 0,
        degraded: true,
      };
    }
  }

  let result;
  try {
    const traverse = traverseGraph(start, { maxDepth, limit, dbPath });
    if (traverse.count === 0) {
      result = {
        query: params,
        text: `未找到与"${start}"相关的多跳关联路径（${maxDepth} 跳内）。`,
        count: 0,
      };
    } else {
      let out = `多跳关联推理（起点: ${start}，最大 ${maxDepth} 跳，共 ${traverse.count} 条路径）:\n\n`;
      for (const p of traverse.paths) {
        out += `  [${p.depth}跳] ${p.path}\n`;
      }
      result = { query: params, text: out, count: traverse.count };
    }
  } catch (e) {
    result = {
      query: params,
      text: `多跳推理执行失败：${e.message}`,
      count: 0,
      degraded: true,
    };
  }

  if (useCache && !result.degraded) cacheSet(cacheKey, result);
  return result;
}
