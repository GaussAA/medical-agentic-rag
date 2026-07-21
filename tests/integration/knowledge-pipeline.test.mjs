// integration/knowledge-pipeline.test.mjs
// Phase B: 知识库全链路集成测试 —— 文件级 SQLite DB + 真实 FTS + 路由约束。
// 在 temp 目录创建小型 knowledge.db，不依赖真实 KB。
// 运行: node tests/integration/knowledge-pipeline.test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = process.cwd();
const KB_ID = "test_kb_001";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; console.error("  ✗", name); }
}

// 在临时目录构建测试 knowledge.db
const TMP = mkdtempSync(join(tmpdir(), "kb-integ-"));
const DB_PATH = join(TMP, "knowledge.db");

console.log("\n=== 知识库全链路集成测试 ===\n");
console.log(`工作目录: ${TMP}`);

// ── Step 1: 创建 knowledge_bases 记录 ──
{
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH);

  db.pragma("journal_mode = WAL");

  // 建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS knowledge_bases (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      source_path TEXT, source_type TEXT DEFAULT 'directory',
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      chunk_count INTEGER DEFAULT 0, file_count INTEGER DEFAULT 0,
      embedding_model TEXT DEFAULT 'multilingual-e5-small', status TEXT DEFAULT 'ready'
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY, kb_id TEXT NOT NULL,
      content_hash TEXT NOT NULL, content TEXT NOT NULL,
      content_tokenized TEXT NOT NULL, file_path TEXT NOT NULL,
      file_type TEXT DEFAULT 'text', start_line INTEGER DEFAULT 0,
      end_line INTEGER DEFAULT 0, metadata_json TEXT DEFAULT '{}',
      indexed_at INTEGER NOT NULL,
      FOREIGN KEY (kb_id) REFERENCES knowledge_bases(id) ON DELETE CASCADE
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      content_tokenized, content=chunks, content_rowid=rowid
    );
  `);

  // 插入 knowledge_base
  db.prepare(`INSERT OR REPLACE INTO knowledge_bases
    (id, name, source_path, created_at, updated_at, chunk_count, file_count)
    VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(KB_ID, "Test KB", TMP, Date.now(), Date.now(), 5, 2);

  const chk = db.prepare("SELECT id FROM knowledge_bases WHERE id=?").get(KB_ID);
  ok(chk?.id === KB_ID, "Step 1: knowledge_bases 创建成功");
  db.close();
}

// ── Step 2: 写入测试 chunks ──
{
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH);

  const insertChunk = db.prepare(`INSERT OR REPLACE INTO chunks
    (id, kb_id, content_hash, content, content_tokenized, file_path,
     file_type, start_line, end_line, indexed_at)
    VALUES (?, ?, ?, ?, ?, ?, 'text', 0, 0, ?)`);

  const now = Date.now();

  // 指南 A: 高血压防治指南 (3 chunks)
  insertChunk.run("c1", KB_ID, "h1", "高血压患者应限制钠盐摄入", "高血压 患者 应 限制 钠盐 摄入", "高血压防治指南.pdf", now);
  insertChunk.run("c2", KB_ID, "h2", "高血压治疗首选ACEI或ARB类药物", "高血压 治疗 首选 ACEI ARB 类药物", "高血压防治指南.pdf", now);
  insertChunk.run("c3", KB_ID, "h3", "血压控制目标130/80mmHg以下", "血压 控制 目标 130 80 mmHg 以下", "高血压防治指南.pdf", now);

  // 指南 B: 糖尿病防治指南 (2 chunks)
  insertChunk.run("c4", KB_ID, "d1", "糖尿病诊断标准为空腹血糖≥7.0mmol/L", "糖尿病 诊断 标准 空腹 血糖 7.0 mmol/L", "糖尿病防治指南.pdf", now);
  insertChunk.run("c5", KB_ID, "d2", "二甲双胍是2型糖尿病的一线治疗药物", "二甲双胍 是 2型 糖尿病 一线 治疗 药物", "糖尿病防治指南.pdf", now);

  const count = db.prepare("SELECT COUNT(*) as c FROM chunks WHERE kb_id=?").get(KB_ID);
  ok(count.c === 5, `Step 2: 插入 5 条 chunks (实际 ${count.c})`);
  db.close();
}

// ── Step 3: 构建 FTS 索引 ──
{
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH);

  // 从 chunks 同步到 fts
  const rows = db.prepare("SELECT rowid, content_tokenized FROM chunks WHERE kb_id=?").all(KB_ID);
  const insertFts = db.prepare("INSERT INTO chunks_fts(rowid, content_tokenized) VALUES (?, ?)");
  const tx = db.transaction(() => {
    for (const r of rows) {
      insertFts.run(r.rowid, r.content_tokenized);
    }
  });
  tx();

  // 验证 FTS 可查询
  const ftsResult = db.prepare(
    "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?"
  ).all("高血压");
  ok(ftsResult.length >= 1, `Step 3: FTS 查询"高血压"命中 ${ftsResult.length} 条`);

  const dmResult = db.prepare(
    "SELECT rowid FROM chunks_fts WHERE chunks_fts MATCH ?"
  ).all("糖尿病");
  ok(dmResult.length >= 1, `FTS 查询"糖尿病"命中 ${dmResult.length} 条`);

  db.close();
}

// ── Step 4: 联合查询（FTS + chunks JOIN）──
{
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH);

  const joined = db.prepare(`
    SELECT c.id, c.file_path, c.content
    FROM chunks_fts f
    JOIN chunks c ON c.rowid = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
    LIMIT 3
  `).all("ACEI");

  ok(joined.length >= 1, `Step 4: 联合查询"ACEI"命中 ${joined.length} 条`);
  ok(joined.some(r => r.file_path === "高血压防治指南.pdf"), "ACEI 结果来自高血压指南");

  db.close();
}

// ── Step 5: 跨指南检索（全库 MATCH）──
{
  const Database = (await import("better-sqlite3")).default;
  const db = new Database(DB_PATH);

  const results = db.prepare(`
    SELECT c.file_path, c.content
    FROM chunks_fts f JOIN chunks c ON c.rowid = f.rowid
    WHERE chunks_fts MATCH ?
    ORDER BY rank
  `).all("治疗");

  ok(results.length >= 2, `Step 5: "治疗"跨指南命中 ${results.length} 条`);
  const guides = new Set(results.map(r => r.file_path));
  ok(guides.size >= 2, `覆盖 ${guides.size} 份指南`);

  db.close();
}

// ── 清理 ──
try { rmSync(TMP, { recursive: true, force: true }); } catch {}

console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) { process.exit(1); }
process.exit(0);
