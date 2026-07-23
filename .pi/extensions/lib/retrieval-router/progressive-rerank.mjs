// progressive-rerank.mjs
// 渐进式重排序 —— BM25 候选集之上的轻量二次排序。
//
// 设计原则：
// 1. 不替换 pi-knowledge 的 bge-reranker，仅在上层加一道快速过滤。
// 2. 利用 BM25 Top-N 候选的文本特征做快速二次评分：
//    - 查询词密度（query token density）
//    - 段落标题匹配（section title 与 query 的 token 重叠）
//    - 临床意图加权（诊断/治疗/药物类查询优先有对应标题的段落）
//    - 疾病匹配（从 chunk-meta sidecar DB 获取 chunk 所属疾病，与查询比对）
//    - 位置衰减（靠后段落的得分自然降低）
// 3. 输出 Top-K 供下游使用，有效减少最后呈现给 LLM 的冗余切片。
//
// 纯 JavaScript（.mjs），无外部依赖，可在 Pi 扩展中直接 import。

import { normalize, tokenize } from "../guide-router.mjs";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

// ── sidecar DB 懒加载 ──
let _metaDb = null;
let _metaStmt = null;

function getMetaDb() {
  if (_metaDb) return _metaDb;
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const dbPath = join(home, ".pi", "cache", "chunk-meta.db");
  if (!existsSync(dbPath)) return null;
  try {
    const require = createRequire(import.meta.url);
    const Database = require("better-sqlite3");
    _metaDb = new Database(dbPath, { readonly: true });
    _metaStmt = _metaDb.prepare("SELECT disease, department, tags, is_deprecated FROM chunk_meta WHERE chunk_id = ?");
    return _metaDb;
  } catch {
    return null;
  }
}

function getChunkMeta(chunkId) {
  const db = getMetaDb();
  if (!db || !_metaStmt) return null;
  try {
    return _metaStmt.get(chunkId);
  } catch {
    return null;
  }
}

// 临床意图段落标题匹配模式
const CLINICAL_INTENT_TITLE = [
  /诊断|定义|临床表现|症状|体征/,
  /治疗|用药|药物|剂量|方案|流程|路径/,
  /检查|实验室|影像|超声|内镜|病理|检验/,
  /预防|筛查|预后|随访|管理/,
  /并发症|不良反应|禁忌|注意|警告/,
  /分期|分型|分级|分类|标准/,
];

/**
 * 轻量二次评分器：在 BM25 得分基础上增加上下文信号。
 *
 * @param {Array} candidates  BM25 原始结果数组，每项含 { file_path, content, score, ... }
 * @param {string} query      用户原始查询
 * @param {object} [opts]
 * @param {number} [opts.densityWeight=0.3]    查询词密度权重
 * @param {number} [opts.titleMatchWeight=0.4]  标题匹配权重
 * @param {number} [opts.positionDecay=0.95]    位置衰减系数
 * @returns {Array} 重排序后的候选集（每项增加 refinedScore）
 */
export function progressiveRerank(candidates, query, opts = {}) {
  if (!candidates || candidates.length === 0) return [];

  const {
    densityWeight = 0.3,
    titleMatchWeight = 0.4,
    diseaseMatchWeight = 0.3,
    positionDecay = 0.95,
  } = opts;

  const qNorm = normalize(query);
  if (!qNorm) return candidates;

  const qTokens = tokenize(query);
  const qTokenCount = qTokens.size;

  // 是否包含临床意图模式
  const hasClinicalIntent = CLINICAL_INTENT_TITLE.some((re) => re.test(query));

  // 先 normalize BM25 得分到 [0,1]
  const rawScores = candidates.map((c) => c.score || 0);
  const maxRaw = Math.max(...rawScores, 1);

  const scored = candidates.map((c, idx) => {
    const content = c.content || c.snippet || "";
    const filePath = c.file_path || "";
    const metadata = c.metadata || {};

    // —— 信号1：BM25 归一化得分 ——
    const bm25Norm = (c.score || 0) / maxRaw;

    // —— 信号2：查询词密度（token 在 chunk 中出现次数 / chunk 长度） ——
    const contentTokens = tokenize(content);
    let hitCount = 0;
    for (const t of qTokens) {
      if (contentTokens.has(t)) hitCount++;
    }
    const density = qTokenCount > 0 ? hitCount / qTokenCount : 0;

    // —— 信号3：标题匹配 ——
    let titleScore = 0;
    const sectionTitle = metadata.section || metadata.title || filePath;
    if (sectionTitle) {
      const titleTokens = tokenize(sectionTitle);
      let titleHits = 0;
      for (const t of qTokens) {
        if (titleTokens.has(t)) titleHits++;
      }
      titleScore = qTokenCount > 0 ? titleHits / qTokenCount : 0;

      // 临床意图查询：如果标题匹配诊断/治疗/用药等模式，加 bonus
      if (hasClinicalIntent && CLINICAL_INTENT_TITLE.some((re) => re.test(sectionTitle))) {
        titleScore = Math.max(titleScore, 0.5);
      }
    }

    // —— 信号4：疾病匹配（从 chunk-meta sidecar DB 获取） ——
    let diseaseScore = 0;
    const chunkId = c.chunk_id || c.chunkId || "";
    if (chunkId) {
      const meta = getChunkMeta(chunkId);
      if (meta && meta.disease) {
        const diseaseTokens = tokenize(meta.disease);
        let diseaseHits = 0;
        for (const t of qTokens) {
          if (diseaseTokens.has(t)) diseaseHits++;
        }
        diseaseScore = qTokenCount > 0 ? diseaseHits / qTokenCount : 0;

        // 如果 chunk 的疾病名包含在查询中（精确匹配），大幅加分
        if (qNorm.includes(normalize(meta.disease))) {
          diseaseScore = Math.max(diseaseScore, 0.8);
        }
      }
    }

    // —— 信号5：位置衰减 ——
    const positionScore = Math.pow(positionDecay, idx);

    // —— 综合评分 ——
    const refinedScore =
      bm25Norm * 0.5 +
      density * densityWeight +
      titleScore * titleMatchWeight +
      diseaseScore * diseaseMatchWeight +
      positionScore * 0.1;

    return {
      ...c,
      refinedScore: Number(refinedScore.toFixed(4)),
      _signals: {
        bm25Norm: Number(bm25Norm.toFixed(4)),
        density: Number(density.toFixed(4)),
        titleScore: Number(titleScore.toFixed(4)),
        diseaseScore: Number(diseaseScore.toFixed(4)),
        positionScore: Number(positionScore.toFixed(4)),
      },
    };
  });

  // 按综合评分降序
  scored.sort((a, b) => b.refinedScore - a.refinedScore || b.score - a.score);
  return scored;
}

/**
 * 两阶段渐进式精排管道。
 *
 * 用法：在 retrieval.orchestrator 中替换直接的 slice(0, limit)：
 *   const reranked = progressivePipeline(bm25Results, query, { initialTopK: 100, finalTopK: 10 });
 *
 * @param {Array} rawResults   BM25 原始结果
 * @param {string} query       用户查询
 * @param {object} [opts]
 * @param {number} [opts.initialTopK=100]  轻量 rerank 前保留的候选数
 * @param {number} [opts.finalTopK=10]     最终保留数
 * @returns {Array}
 */
export function progressivePipeline(rawResults, query, opts = {}) {
  const { initialTopK = 100, finalTopK = 10 } = opts;

  if (!rawResults || rawResults.length === 0) return [];

  // 第一阶段：取 BM25 Top-N
  const candidates = rawResults.slice(0, initialTopK);

  // 第二阶段：轻量二次评分 + 重排序
  const reranked = progressiveRerank(candidates, query, opts);

  // 返回 Top-K
  return reranked.slice(0, finalTopK);
}
