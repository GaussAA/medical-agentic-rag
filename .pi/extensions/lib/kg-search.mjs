// kg-search.mjs
// 医疗知识图谱检索纯函数：按疾病/实体类型/关系过滤扁平实体表，并格式化输出。
//
// 抽取自原 kg-search-tool.ts，逻辑保持一致；新增文件化缓存，降低重复查询开销。
// 纯 JavaScript（.mjs），供 kg-search-tool.ts（经 jiti）与 tests/eval-bench.mjs（原生 node）共用。

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cacheGet, cacheSet } from "./retrieval-cache.mjs";

const ENTITY_LABEL = {
  drug: "药物",
  symptom: "症状",
  examination: "检查",
  riskFactor: "危险因素",
  treatment: "治疗",
};

/** 读取知识图谱实体（默认项目根下的 medical-knowlegde-base/.knowledge-graph.json）。 */
export function loadGraph(baseDir = process.cwd()) {
  const p = join(baseDir, "medical-knowlegde-base", ".knowledge-graph.json");
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
