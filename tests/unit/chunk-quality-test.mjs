// chunk-quality-test.mjs
// 分片质量评测单测 —— 纯函数 + 注入数据，原生 node 运行，零真实 DB / 零 Key。
// 运行: node tests/unit/chunk-quality-test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const origCwd = process.cwd();
const workdir = mkdtempSync(join(tmpdir(), "cq-test-"));
process.chdir(workdir);

// 动态加载 better-sqlite3（单测仅用于构造内存 DB，真实评测不依赖）
function loadBetterSqlite3() {
  const require = createRequire(import.meta.url);
  const candidates = [
    "better-sqlite3",
    join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules", "better-sqlite3"),
  ].filter(Boolean);
  for (const c of candidates) {
    try {
      const m = require(c);
      if (m) return m.default || m;
    } catch {}
  }
  return null;
}
const dbPath = join(workdir, "mem.db");
const Database = loadBetterSqlite3();
let db = null;
if (Database) {
  db = new Database(dbPath);
  db.exec(
    "CREATE TABLE chunks (id TEXT, kb_id TEXT, content TEXT, file_path TEXT, start_line INTEGER)",
  );
}

const MOD = pathToFileURL(join(origCwd, "scripts/kb/chunk-quality.mjs")).href;
const cq = await import(MOD);

let passed = 0,
  failed = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log("  ✓", name);
  } else {
    failed++;
    fails.push(name + (extra ? " :: " + extra : ""));
    console.log("  ✗", name, extra);
  }
}

console.log("\n=== 分片质量评测单测 ===\n");

// ---------- 1) sizeStats ----------
console.log("[1] sizeStats — 规模分布");
{
  const chunks = [
    { content: "短" },
    { content: "x".repeat(300) },
    { content: "x".repeat(600) },
    { content: "x".repeat(900) },
    { content: "x".repeat(2000) },
  ];
  const s = cq.sizeStats(chunks);
  ok("count=5", s.count === 5);
  ok("min=1", s.min === 1);
  ok("max=2000", s.max === 2000);
  ok("small(<200)=1", s.small === 1, "got " + s.small);
  ok("large(>1500)=1", s.large === 1, "got " + s.large);
  ok("中位数=600", s.median === 600, "got " + s.median);
  ok("直方图桶数=9", s.hist.length === 9);
  ok("直方图计数总和=5", s.hist.reduce((a, b) => a + b.count, 0) === 5);
}
{
  const s = cq.sizeStats([]);
  ok("空输入安全", s.count === 0 && s.mean === 0 && s.hist.length === 0);
}

// ---------- 2) referenceLocatability ----------
console.log("\n[2] referenceLocatability — 证据可定位率");
{
  const chunks = [
    { content: "推荐索拉非尼作为一线靶向药物" },
    { content: "仑伐替尼联合方案用于晚期肝癌" },
    { content: "某无关内容，无证据短语" },
  ];
  const phrases = ["索拉非尼", "仑伐替尼", "不存在的短语XYZ"];
  const r = cq.referenceLocatability(chunks, phrases);
  ok("total=3", r.total === 3);
  ok("located=2", r.located === 2, "got " + r.located);
  ok("rate=0.667", Math.abs(r.rate - 0.667) < 0.01, "got " + r.rate);
  ok("missing 含未命中项", r.missing.includes("不存在的短语XYZ"));
}
{
  const r = cq.referenceLocatability([{ content: "x" }], []);
  ok("无短语 → rate=null", r.rate === null && r.total === 0);
}

// ---------- 3) entityFragmentation ----------
console.log("\n[3] entityFragmentation — 医学实体跨片切断率");
{
  // 边界对1：上一片尾「500」+ 下一片头「mg」→ 切断
  const chunks = [
    { content: "成人剂量为 500" },
    { content: "mg 每日一次口服" },
    { content: "常规随访即可" },
    { content: "儿童按 10" },
    { content: "mg/kg 计算" },
  ];
  const ef = cq.entityFragmentation(chunks);
  ok("边界对=4（5 chunk 的相邻边界）", ef.pairs === 4, "got " + ef.pairs);
  ok("切断=2（500‖mg, 10‖mg/kg）", ef.fragmented === 2, "got " + ef.fragmented);
  ok("rate=0.5（2/4 边界切断）", Math.abs(ef.rate - 0.5) < 0.01, "got " + ef.rate);
  ok("示例非空", ef.examples.length > 0);
}
{
  // 不切断：数值与单位同在一片
  const chunks = [{ content: "剂量 500 mg 每日" }, { content: "随访观察" }];
  const ef = cq.entityFragmentation(chunks);
  ok("同片不误报（1 边界未切断）", ef.fragmented === 0 && ef.pairs === 1, "pairs=" + ef.pairs + " frag=" + ef.fragmented);
}

// ---------- 4) sectionContext ----------
console.log("\n[4] sectionContext — 层级归属完整度");
{
  const chunks = [
    { content: "一、诊断标准\n文本内容" }, // 带章节
    { content: "这是正文段落，无标题" }, // orphan
    { content: "1. 治疗原则\n内容" }, // 带章节
  ];
  const sc = cq.sectionContext(chunks);
  ok("total=3", sc.total === 3);
  ok("withSection=2", sc.withSection === 2, "got " + sc.withSection);
  ok("orphan=1", sc.orphan === 1);
  ok("orphanRate≈0.333", Math.abs(sc.orphanRate - 0.333) < 0.01, "got " + sc.orphanRate);
}

// ---------- 5) evaluateChunks 聚合 + 真实内存 DB 端到端 ----------
console.log("\n[5] evaluateChunks 聚合 + 内存 DB 注入");
{
  const chunks = [
    { content: "一、推荐药物\n索拉非尼一线", file_path: "肝癌.md", start_line: 1 },
    { content: "剂量 500", file_path: "肝癌.md", start_line: 5 },
    { content: "mg 每日", file_path: "肝癌.md", start_line: 6 },
  ];
  const rep = cq.evaluateChunks(chunks, { phrases: ["索拉非尼"] });
  ok("聚合含四项指标", rep.size && rep.referenceLocatability && rep.entityFragmentation && rep.sectionContext);
  ok("引用可定位率=100%", rep.referenceLocatability.rate === 1);
  ok("实体切断率>0", rep.entityFragmentation.fragmented >= 1);

  if (db) {
    db.exec("DELETE FROM chunks");
    const ins = db.prepare("INSERT INTO chunks (id,kb_id,content,file_path,start_line) VALUES (?,?,?,?,?)");
    for (const c of chunks) ins.run("id-" + Math.random(), "kb", c.content, c.file_path, c.start_line);
    // 验证真实 knowledge.db 表结构兼容（用相同 schema 的内存库模拟）
    const rows = db.prepare("SELECT content, file_path, start_line FROM chunks ORDER BY file_path, start_line").all();
    ok("内存 DB 读取成功", rows.length === 3 && rows[0].content.includes("推荐药物"));
  } else {
    console.log("  (跳过：better-sqlite3 不可用，纯函数部分已覆盖)");
  }
}

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  -", f);
}

process.chdir(origCwd);
try {
  if (db) db.close();
  rmSync(workdir, { recursive: true, force: true });
} catch {}

process.exit(failed === 0 ? 0 : 1);
