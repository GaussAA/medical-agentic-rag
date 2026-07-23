// inject-chunk-meta.mjs
// 分片 metadata 注入 —— 为知识库 chunks 补全疾病/科室/标签等结构化信息。
//
// 流程：
//   1. 读取 knowledge.db 的所有分片
//   2. 读取 guide-index.json（病种/版本/人群）
//   3. 读取 kb-sources.json（科室/标签）
//   4. 按 file_path 匹配注入
//   5. 写入 .pi/cache/chunk-meta.db（sidecar，不碰 pi-knowledge 内部 DB）
//
// 用法:
//   node scripts/kb/enrich/inject-chunk-meta.mjs             全量注入
//   node scripts/kb/enrich/inject-chunk-meta.mjs --force     覆盖已有
//   node scripts/kb/enrich/inject-chunk-meta.mjs --stats     仅看统计，不写入

import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const KNOWLEDGE_DB = join(HOME, ".pi", "knowledge", "knowledge.db");

const CACHE_DIR = join(ROOT, ".pi", "cache");
const META_DB = join(CACHE_DIR, "chunk-meta.db");

const KB_DIR = join(ROOT, "data", "kb");
const SOURCES_PATH = join(KB_DIR, "kb-sources.json");
const INDEX_PATH = join(KB_DIR, ".guide-index.json");

// ── 加载参考资料 ──

function loadGuideIndex() {
  try {
    return JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  } catch { return null; }
}

function loadSources() {
  try {
    return JSON.parse(readFileSync(SOURCES_PATH, "utf-8"));
  } catch { return null; }
}

/**
 * 构建文件名 → 指南元数据的映射。
 * 规则：chunk 的 file_path 前 30 字符若包含 guide title 的前 20 字符即匹配。
 */
function buildFileMetaMap(guideIndex, sources) {
  const map = new Map();

  if (guideIndex?.guideMap) {
    for (const [title, info] of Object.entries(guideIndex.guideMap)) {
      // title 可能是 "1.2026年国家医疗质量安全改进目标" 等
      // 构建多个匹配 key（完整名、简短版、无编号版）
      const keys = [title];
      // 去掉开头的数字编号
      const stripped = title.replace(/^\d+[\.\．]\s*/, "");
      if (stripped !== title) keys.push(stripped);
      // 截断前 30 字符
      if (title.length > 30) keys.push(title.slice(0, 30));

      for (const key of keys) {
        if (!map.has(key) || map.get(key).length < (info.keywords?.length || 0)) {
          map.set(key, {
            disease: info.disease || "",
            version: info.version || null,
            audience: info.audience || "",
            org: info.org || "",
            isDeprecated: info.deprecated ? 1 : 0,
            supersededBy: info.supersededBy || "",
          });
        }
      }
    }
  }

  // 补充 sources 中的 department 和 tags
  if (sources?.sources) {
    for (const s of sources.sources) {
      const key = s.name || s.id;
      if (!key) continue;
      const existing = map.get(key) || {};
      existing.department = s.department || existing.department || "";
      existing.tags = s.tags || [];
      existing.name = s.name || "";
      map.set(key, existing);

      // 也用小名匹配
      const short = key.replace(/^\d+[\.\．]\s*/, "");
      if (short !== key) {
        const e2 = map.get(short) || { ...existing };
        if (!e2.department) e2.department = existing.department;
        if (!e2.tags?.length) e2.tags = existing.tags || [];
        map.set(short, e2);
      }
    }
  }

  return map;
}

/**
 * 匹配 chunk 的 file_path 到指南元数据。
 */
function matchFile(filePath, fileMetaMap) {
  const base = basename(filePath).replace(/\.\w+$/, ""); // 去掉扩展名
  const candidates = [];

  for (const [key, meta] of fileMetaMap) {
    // 优先精确匹配
    if (base === key || filePath.includes(key)) {
      candidates.push({ key, meta, score: filePath === key ? 3 : base === key ? 2 : 1 });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.score - a.score);
  return candidates[0].meta;
}

function main() {
  const args = process.argv.slice(2);
  const FORCE = args.includes("--force");
  const STATS_ONLY = args.includes("--stats");

  if (!existsSync(KNOWLEDGE_DB)) {
    console.error(`knowledge.db 不存在: ${KNOWLEDGE_DB}`);
    console.error("请先运行 npm run kb:rebuild 构建知识库");
    process.exit(1);
  }

  // 加载参考数据
  const guideIndex = loadGuideIndex();
  const sources = loadSources();
  const fileMetaMap = buildFileMetaMap(guideIndex, sources);

  console.log(`已加载: guide-index ${guideIndex?.totalGuides || 0} 条, kb-sources ${(sources?.sources || []).length} 条`);
  console.log(`文件名映射表: ${fileMetaMap.size} 条`);

  // 读 knowledge.db
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const srcDb = new Database(KNOWLEDGE_DB, { readonly: true });

  const totalChunks = srcDb.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
  const chunks = srcDb.prepare("SELECT id, file_path FROM chunks").all();

  srcDb.close();

  console.log(`knowledge.db: ${totalChunks} 个��片`);

  // 匹配统计
  let matched = 0;
  let matchedDisease = 0;
  const counts = {};

  const metaRows = [];
  for (const c of chunks) {
    const meta = matchFile(c.file_path, fileMetaMap);
    if (meta) {
      matched++;
      if (meta.disease) matchedDisease++;
      counts[meta.disease || "(无病种)"] = (counts[meta.disease || "(无病种)"] || 0) + 1;

      metaRows.push({
        chunk_id: c.id,
        file_path: c.file_path,
        disease: meta.disease || "",
        department: meta.department || "",
        version: meta.version,
        audience: meta.audience || "",
        org: meta.org || "",
        is_deprecated: meta.isDeprecated || 0,
        tags: JSON.stringify(meta.tags || []),
        superseded_by: meta.supersededBy || "",
      });
    }
  }

  console.log(`匹配结果:`);
  console.log(`  命中指南元数据: ${matched} / ${totalChunks} (${(matched / totalChunks * 100).toFixed(1)}%)`);
  console.log(`  命中病种:      ${matchedDisease} / ${totalChunks} (${(matchedDisease / totalChunks * 100).toFixed(1)}%)`);

  // 病种分布 top10
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  console.log(`\n病种分片分布 TOP15:`);
  for (const [disease, cnt] of sorted.slice(0, 15)) {
    const bar = "▓".repeat(Math.round((cnt / totalChunks) * 30));
    console.log(`  ${(disease || "(匹配失败)").padEnd(16)} ${String(cnt).padStart(5)}  ${bar}`);
  }

  if (STATS_ONLY) {
    process.exit(0);
  }

  // 写入 sidecar DB
  const targetDbPath = META_DB;
  mkdirSync(CACHE_DIR, { recursive: true });

  // 如果是 --force 删除旧库
  if (FORCE && existsSync(targetDbPath)) {
    rmSync(targetDbPath, { force: true });
  }

  const isNew = !existsSync(targetDbPath);
  const metaDb = new Database(targetDbPath);

  if (isNew || FORCE) {
    metaDb.exec(`
      CREATE TABLE IF NOT EXISTS chunk_meta (
        chunk_id TEXT PRIMARY KEY,
        file_path TEXT NOT NULL DEFAULT '',
        disease TEXT NOT NULL DEFAULT '',
        department TEXT NOT NULL DEFAULT '',
        version INTEGER,
        audience TEXT NOT NULL DEFAULT '',
        org TEXT NOT NULL DEFAULT '',
        is_deprecated INTEGER NOT NULL DEFAULT 0,
        tags TEXT NOT NULL DEFAULT '[]',
        superseded_by TEXT NOT NULL DEFAULT '',
        injected_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_chunk_meta_disease ON chunk_meta(disease);
      CREATE INDEX IF NOT EXISTS idx_chunk_meta_department ON chunk_meta(department);
    `);
  }

  const ts = Date.now();
  const insert = metaDb.prepare(`
    INSERT OR REPLACE INTO chunk_meta
      (chunk_id, file_path, disease, department, version, audience, org,
       is_deprecated, tags, superseded_by, injected_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const tx = metaDb.transaction(() => {
    for (const r of metaRows) {
      insert.run(r.chunk_id, r.file_path, r.disease, r.department, r.version,
                 r.audience, r.org, r.is_deprecated, r.tags, r.superseded_by, ts);
    }
  });
  tx();

  metaDb.close();

  console.log(`\n✓ 已写入 ${metaRows.length} 条 → ${targetDbPath}`);
  console.log(`  sidecar DB 大小: ${(readFileSync(targetDbPath).length / 1024).toFixed(0)} KB`);
}

try {
  main();
} catch (err) {
  console.error("[inject-chunk-meta] 失败:", err);
  process.exit(1);
}
