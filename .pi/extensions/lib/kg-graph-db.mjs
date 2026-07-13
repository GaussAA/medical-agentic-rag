// kg-graph-db.mjs
// 知识图谱的 SQLite 存储与多跳推理（递归 CTE）。
//
// 背景：原 kg-search.mjs 把 .knowledge-graph.json 的扁平三元组仅做文本匹配，
// 未发挥图推理价值。本模块将三元组导入 SQLite 的二分图（疾病 ↔ 实体），
// 用递归 CTE 做多跳游走（如「高血压 → 用氨氯地平 → 氨氯地平还用于冠心病」），
// 不引入 Neo4j，复用项目已依赖的 better-sqlite3（零新增基础设施）。
//
// 数据模型（来自 .knowledge-graph.json 的 entities 数组）：
//   每条 = { disease, entityType, entityName, relation, source }
//   即三元组 (subject=disease, predicate=relation, object=entityName)
//   其中 object 可为 药物/症状/检查/危险因素/治疗。
// 多跳即在「疾病 → 实体 → 疾病 → …」的二分图上交替游走。
//
// 纯 JavaScript（.mjs），无 TS 语法：供 kg-search.mjs（jiti）与 tests（原生 node）共用。
// better-sqlite3 加载沿用 retrieval-router.mjs 的候选路径兜底，兼容 jiti 与原生 node。

import { existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

/**
 * 动态加载 better-sqlite3（候选路径兜底，同 retrieval-router）。
 * @returns {Function} better-sqlite3 的 Database 构造函数
 */
function loadBetterSqlite3() {
  const candidates = [
    "better-sqlite3",
    process.env.PI_AGENT_NPM && join(process.env.PI_AGENT_NPM, "node_modules", "better-sqlite3"),
    "C:/Users/JaNiy/.pi/agent/npm/node_modules/better-sqlite3",
    join(
      process.env.USERPROFILE || process.env.HOME || "",
      ".pi",
      "agent",
      "npm",
      "node_modules",
      "better-sqlite3",
    ),
  ].filter(Boolean);
  let lastErr;
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (mod) return mod.default || mod;
    } catch (e) {
      lastErr = e;
    }
  }
  throw new Error("better-sqlite3 不可用（pi-knowledge 未安装？）：" + (lastErr?.message || ""));
}

let _Database = null;
function getDatabase() {
  if (!_Database) _Database = loadBetterSqlite3();
  return _Database;
}

/**
 * 图谱 DB 默认路径（与派生索引同目录，作为可重建的派生产物，gitignore）。
 * @param {string} [baseDir]
 * @returns {string}
 */
export function graphDbPath(baseDir = process.cwd()) {
  return join(baseDir, "knowledge-base", ".knowledge-graph.db");
}

/**
 * 图谱 JSON 默认路径。
 * @param {string} [baseDir]
 * @returns {string}
 */
export function graphJsonPath(baseDir = process.cwd()) {
  return join(baseDir, "knowledge-base", ".knowledge-graph.json");
}

/**
 * 从 JSON 构建图谱 SQLite（建表 + 导入三元组 + 索引）。
 * 幂等：已存在且与 JSON 同源（mtime 新于 DB）则跳过重建。
 * @param {object} [opts]
 * @param {string} [opts.jsonPath] 三元组 JSON 路径（默认 graphJsonPath）
 * @param {string} [opts.dbPath] 输出 DB 路径（默认 graphDbPath）
 * @param {boolean} [opts.force] 强制重建（忽略 mtime）
 * @returns {{dbPath:string, entities:number, edges:number}}
 */
export function ensureGraphDb(opts = {}) {
  const jsonPath = opts.jsonPath || graphJsonPath();
  const dbPath = opts.dbPath || graphDbPath();
  const force = opts.force || false;

  if (!existsSync(jsonPath)) {
    throw new Error(`图谱 JSON 不存在: ${jsonPath}`);
  }
  // 增量跳过：DB 存在且比 JSON 新，无需重建
  if (!force && existsSync(dbPath)) {
    try {
      if (statSync(dbPath).mtimeMs > statSync(jsonPath).mtimeMs) {
        const db = openReadonly(dbPath);
        const cnt = db.prepare("SELECT COUNT(*) AS c FROM kg_edge").get().c;
        db.close();
        return { dbPath, entities: cnt, edges: cnt, skipped: true };
      }
    } catch {
      /* 读取失败则重建 */
    }
  }

  const Database = getDatabase();
  const data = JSON.parse(readFileSync(jsonPath, "utf-8"));
  const entities = Array.isArray(data.entities) ? data.entities : [];

  const db = new Database(dbPath);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("busy_timeout = 5000");
    db.exec(`
      DROP TABLE IF EXISTS kg_edge;
      CREATE TABLE kg_edge (
        subject     TEXT NOT NULL,   -- 疾病名
        predicate   TEXT NOT NULL,   -- 关系（treated_with/has_symptom/...）
        object      TEXT NOT NULL,   -- 实体名（药物/症状/检查/...）
        object_type TEXT,            -- drug/symptom/examination/riskFactor/treatment
        source      TEXT
      );
      CREATE INDEX idx_kg_subject ON kg_edge(subject);
      CREATE INDEX idx_kg_object  ON kg_edge(object);
    `);
    const insert = db.prepare(
      "INSERT INTO kg_edge (subject, predicate, object, object_type, source) VALUES (?, ?, ?, ?, ?)",
    );
    const tx = db.transaction((rows) => {
      for (const e of rows) {
        insert.run(e.disease || "", e.relation || "", e.entityName || "", e.entityType || "", e.source || "");
      }
    });
    tx(entities);
  } finally {
    db.close();
  }
  return { dbPath, entities: entities.length, edges: entities.length, skipped: false };
}

/** 只读打开（供查询，不写）。 */
function openReadonly(dbPath) {
  const Database = getDatabase();
  return new Database(dbPath, { readonly: true, fileMustExist: true });
}

/**
 * 多跳遍历：从起始节点在「疾病 ↔ 实体」二分图上递归游走。
 * 起点可为疾病或实体；交替沿 subject=node 或 object=node 扩展，depth 控制跳数。
 *
 * @param {string} startName 起始实体或疾病名（精确匹配 subject/object）
 * @param {object} [opts]
 * @param {number} [opts.maxDepth=2] 最大跳数（2 = 疾病→实体→疾病）
 * @param {number} [opts.limit=60] 返回路径上限
 * @param {string} [opts.dbPath] DB 路径（默认 graphDbPath）
 * @param {boolean} [opts.includeSelf=false] 是否包含起点本身（depth=0）
 * @returns {{startName:string, maxDepth:number, paths:Array, count:number}}
 */
export function traverseGraph(startName, opts = {}) {
  const maxDepth = opts.maxDepth || 2;
  const limit = opts.limit || 60;
  const dbPath = opts.dbPath || graphDbPath();
  if (!existsSync(dbPath)) {
    throw new Error(`图谱 DB 未就绪: ${dbPath}（请先运行 build-kg-db）`);
  }
  const db = openReadonly(dbPath);
  try {
    const rows = db
      .prepare(
        `
        WITH RECURSIVE walk(
          node, node_role, depth, path, via_predicate, src
        ) AS (
          -- 起点1：startName 作为疾病（subject）出发
          SELECT subject, 'disease', 0, subject, '', ''
          FROM kg_edge WHERE subject = @start
          UNION ALL
          -- 起点2：startName 作为实体（object）反向出发
          SELECT object, 'entity', 0, object, '', ''
          FROM kg_edge WHERE object = @start
          UNION ALL
          -- 从疾病走到实体（subject = 当前疾病）
          SELECT e.object, e.object_type, w.depth + 1,
                 w.path || ' --' || e.predicate || '--> ' || e.object,
                 e.predicate, e.source
          FROM walk w JOIN kg_edge e ON e.subject = w.node
          WHERE w.node_role = 'disease' AND w.depth < @maxDepth
          UNION ALL
          -- 从实体走回疾病（object = 当前实体）
          SELECT e.subject, 'disease', w.depth + 1,
                 w.path || ' <--' || e.predicate || '-- ' || e.subject,
                 e.predicate, e.source
          FROM walk w JOIN kg_edge e ON e.object = w.node
          WHERE w.node_role = 'entity' AND w.depth < @maxDepth
        )
        SELECT DISTINCT node, node_role, depth, path, via_predicate, src
        FROM walk
        WHERE depth > 0
        ORDER BY depth, node
        LIMIT @limit
      `,
      )
      .all({ start: startName, maxDepth, limit });

    return {
      startName,
      maxDepth,
      paths: rows.map((r) => ({
        node: r.node,
        role: r.node_role,
        depth: r.depth,
        path: r.path,
        via: r.via_predicate,
        source: r.src,
      })),
      count: rows.length,
    };
  } finally {
    db.close();
  }
}
