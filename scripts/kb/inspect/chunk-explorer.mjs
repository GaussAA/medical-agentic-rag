// chunk-explorer.mjs
// 分片浏览器 —— 查看 pi-knowledge 知识库的分片结构、内容与元数据。
//
// 用法:
//   node scripts/kb/inspect/chunk-explorer.mjs stats          概览统计
//   node scripts/kb/inspect/chunk-explorer.mjs list          文件分片排行榜
//   node scripts/kb/inspect/chunk-explorer.mjs sample        随机分片样本（含完整 metadata）
//   node scripts/kb/inspect/chunk-explorer.mjs file <path>   查看指定文件的分片列表
//   node scripts/kb/inspect/chunk-explorer.mjs search <词>    全文搜索分片
//   node scripts/kb/inspect/chunk-explorer.mjs disease <名>   按病种搜索分片
//   node scripts/kb/inspect/chunk-explorer.mjs html          生成可视化 HTML 报告

import { readFileSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const KB_DIR = join(ROOT, "data", "kb");

// ── 获知 knowledge.db 路径 ──
const HOME = process.env.USERPROFILE || process.env.HOME || "";
const KNOWLEDGE_DB = join(HOME, ".pi", "knowledge", "knowledge.db");

let db = null;
function getDb() {
  if (db) return db;
  if (!existsSync(KNOWLEDGE_DB)) {
    console.error(`knowledge.db 不存在: ${KNOWLEDGE_DB}`);
    process.exit(1);
  }
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  db = new Database(KNOWLEDGE_DB, { readonly: true });
  return db;
}

// ── 加载 guide-index 获取病种映射 ──
function loadGuideMap() {
  try {
    const path = join(KB_DIR, ".guide-index.json");
    if (existsSync(path)) {
      const idx = JSON.parse(readFileSync(path, "utf-8"));
      return idx.guideMap || {};
    }
  } catch {}
  return {};
}

function fmtBytes(n) {
  if (n > 1000) return (n / 1000).toFixed(1) + "KB";
  return n + "B";
}

// ── 命令处理器 ──

function cmdStats() {
  const d = getDb();
  const total = d.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
  const totalFiles = d.prepare("SELECT COUNT(DISTINCT file_path) as c FROM chunks").get().c;
  const totalChars = d.prepare("SELECT SUM(LENGTH(content)) as s FROM chunks").get().s || 0;
  const avgLen = total > 0 ? Math.round(totalChars / total) : 0;
  const kbs = d.prepare("SELECT * FROM knowledge_bases").all();

  console.log("━━━ 知识库分片概览 ━━━\n");
  for (const kb of kbs) {
    console.log(`  知识库:  ${kb.name}`);
    console.log(`  KB ID:   ${kb.id}`);
    console.log(`  源目录:  ${kb.source_path}`);
    console.log(`  嵌入模型: ${kb.embedding_model}`);
    console.log(`  状态:    ${kb.status}`);
    console.log();
  }
  console.log(`  分片总数:   ${total.toLocaleString()}`);
  console.log(`  源文件数:   ${totalFiles}`);
  console.log(`  总字符数:   ${fmtBytes(totalChars)}`);
  console.log(`  平均分片长度: ${avgLen} 字符`);

  // 分片长度分布
  const dist = d.prepare(`
    SELECT
      CASE
        WHEN LENGTH(content) < 100 THEN '<100'
        WHEN LENGTH(content) < 300 THEN '100-300'
        WHEN LENGTH(content) < 500 THEN '300-500'
        WHEN LENGTH(content) < 1000 THEN '500-1K'
        ELSE '>1K'
      END as bucket,
      COUNT(*) as cnt
    FROM chunks GROUP BY bucket ORDER BY MIN(LENGTH(content))
  `).all();
  console.log(`\n  分片长度分布:`);
  for (const b of dist) {
    const bar = "█".repeat(Math.round((b.cnt / total) * 30));
    console.log(`    ${b.bucket.padEnd(8)} ${String(b.cnt).padStart(5)}  ${bar}`);
  }
}

function cmdList() {
  const d = getDb();
  const top = d.prepare(`
    SELECT file_path, COUNT(*) as cnt, ROUND(AVG(LENGTH(content))) as avgLen
    FROM chunks GROUP BY file_path ORDER BY cnt DESC LIMIT 30
  `).all();

  const guideMap = loadGuideMap();
  const total = d.prepare("SELECT COUNT(*) as c FROM chunks").get().c;

  console.log(`━━━ 文件分片排行榜（全库 ${total} 分片）━━━\n`);
  for (let i = 0; i < top.length; i++) {
    const t = top[i];
    const file = basename(t.file_path);
    const pct = ((t.cnt / total) * 100).toFixed(1);

    // 尝试匹配 guide-index
    let disease = "";
    for (const [title, info] of Object.entries(guideMap)) {
      if (t.file_path.includes(title.slice(0, 20))) {
        disease = info.disease || "";
        break;
      }
    }

    const bar = "▓".repeat(Math.round((t.cnt / top[0].cnt) * 25));
    console.log(`  ${String(i + 1).padStart(2)}. ${file}`);
    console.log(`     分片 ${String(t.cnt).padStart(4)}  ${pct.padStart(5)}%  均长 ${t.avgLen}B  ${disease ? `[${disease}]` : ""}`);
    console.log(`     ${bar}`);
  }
}

function cmdSample() {
  const d = getDb();
  // 取一个 metadata 不为空的 chunk
  const row = d.prepare(`
    SELECT id, kb_id, file_path, content_hash, content, start_line, end_line, metadata_json, indexed_at
    FROM chunks WHERE metadata_json != '{}' ORDER BY RANDOM() LIMIT 1
  `).get();

  if (!row) {
    console.log("（无 metadata 样本）");
    return;
  }

  const meta = JSON.parse(row.metadata_json || "{}");
  const content = (row.content || "").slice(0, 800);

  console.log("━━━ 分片样本（含 metadata）━━━\n");
  console.log(`  ID:         ${row.id}`);
  console.log(`  KB ID:      ${row.kb_id}`);
  console.log(`  文件:        ${row.file_path}`);
  console.log(`  行号范围:    ${row.start_line} - ${row.end_line}`);
  console.log(`  内容哈希:    ${row.content_hash?.slice(0, 16)}...`);
  console.log(`  索引时间:    ${new Date(row.indexed_at).toISOString()}`);
  console.log(`  内容长度:    ${content.length} 字符`);
  console.log(`\n  metadata:`);
  for (const [k, v] of Object.entries(meta)) {
    console.log(`    ${k}: ${JSON.stringify(v).slice(0, 100)}`);
  }
  console.log(`\n  ── 内容 ──`);
  console.log(`  ${content.replace(/\n/g, "\n  ")}`);
  console.log(`  ── 内容结束 ──`);

  // 再取一个纯文本的对比
  console.log(`\n  ── 纯文本分片（对比，无 metadata）──`);
  const plain = d.prepare(`
    SELECT id, file_path, content, start_line, end_line
    FROM chunks WHERE metadata_json = '{}' AND LENGTH(content) > 50
    ORDER BY RANDOM() LIMIT 1
  `).get();

  if (plain) {
    const pContent = (plain.content || "").slice(0, 400);
    console.log(`  ID: ${plain.id}`);
    console.log(`  文件: ${plain.file_path}`);
    console.log(`  行: ${plain.start_line}-${plain.end_line}`);
    console.log(`  ${pContent.replace(/\n/g, "\n  ")}`);
  }
}

function cmdFile(filePath) {
  const d = getDb();
  // 模糊匹配
  const chunks = d.prepare(`
    SELECT id, file_path, start_line, end_line, metadata_json, LENGTH(content) as clen, SUBSTR(content, 1, 200) as preview
    FROM chunks WHERE file_path LIKE ? ORDER BY start_line
  `).all(`%${filePath}%`);

  if (chunks.length === 0) {
    console.log(`未找到匹配文件: ${filePath}`);
    return;
  }

  console.log(`━━━ 文件分片清单: ${chunks[0].file_path}（共 ${chunks.length} 个分片）━━━\n`);
  for (const c of chunks) {
    const meta = JSON.parse(c.metadata_json || "{}");
    const metaStr = Object.keys(meta).length > 0
      ? Object.entries(meta).map(([k, v]) => `${k}=${String(v).slice(0, 30)}`).join(" ")
      : "(无 metadata)";
    console.log(`  [${c.start_line.toString().padStart(4)}-${c.end_line.toString().padStart(4)}] ${c.clen}B`);
    console.log(`    ID: ${c.id.slice(0, 16)}...`);
    console.log(`    metadata: ${metaStr}`);
    console.log(`    ${c.preview.replace(/\n/g, " ").slice(0, 120)}`);
    console.log();
  }
}

function cmdSearch(query) {
  const d = getDb();
  const results = d.prepare(`
    SELECT id, file_path, start_line, end_line, LENGTH(content) as clen, SUBSTR(content, 1, 250) as snippet
    FROM chunks WHERE content LIKE ? ORDER BY file_path, start_line LIMIT 20
  `).all(`%${query}%`);

  if (results.length === 0) {
    console.log(`未找到包含 "${query}" 的分片`);
    return;
  }

  console.log(`━━━ 搜索 "${query}" → ${results.length} 条结果 ━━━\n`);
  for (const r of results) {
    // 高亮关键词
    const snippet = r.snippet.replace(
      new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"),
      (m) => `\x1b[31m${m}\x1b[0m`,
    );
    console.log(`  [${r.file_path}] L${r.startLine}-${r.endLine} (${r.clen}B)`);
    console.log(`  ${snippet.replace(/\n/g, " ").slice(0, 150)}...\n`);
  }
}

function cmdDisease(disease) {
  // 先查 guide-index 找到对应文件，再查 chunks
  const guideMap = loadGuideMap();
  const files = new Set();
  for (const [title, info] of Object.entries(guideMap)) {
    const dept = info.disease || "";
    if (dept.includes(disease) || title.includes(disease)) {
      files.add(title);
    }
  }

  if (files.size === 0) {
    console.log(`未找到病种 "${disease}" 对应的文件`);
    return;
  }

  console.log(`━━━ 病种 "${disease}" → ${files.size} 个关联文件 ━━━\n`);
  for (const f of files) {
    const short = f.slice(0, 50);
    // 查此文件的分片数
    const d = getDb();
    const row = d.prepare(`
      SELECT COUNT(*) as cnt, SUM(LENGTH(content)) as total, MIN(start_line) as sl, MAX(end_line) as el
      FROM chunks WHERE file_path LIKE ?
    `).get(`%${short}%`);
    if (row && row.cnt > 0) {
      console.log(`  ${f}`);
      console.log(`    分片 ${row.cnt}  |  总 ${fmtBytes(row.total)}  |  行 ${row.sl}-${row.el}`);
    } else {
      console.log(`  ${f}  （文件未检索到分片，可能已移除）`);
    }
  }
}

function cmdHtml() {
  const d = getDb();
  const outDir = join(ROOT, "docs", "chunk-report");
  mkdirSync(outDir, { recursive: true });

  // 收集数据
  const total = d.prepare("SELECT COUNT(*) as c FROM chunks").get().c;
  const totalFiles = d.prepare("SELECT COUNT(DISTINCT file_path) as c FROM chunks").get().c;
  const totalChars = d.prepare("SELECT SUM(LENGTH(content)) as s FROM chunks").get().s || 0;
  const avgLen = total > 0 ? Math.round(totalChars / total) : 0;

  const topFiles = d.prepare(`
    SELECT file_path, COUNT(*) as cnt, ROUND(AVG(LENGTH(content))) as avgLen,
           ROUND(AVG(LENGTH(content))) as avgLen2
    FROM chunks GROUP BY file_path ORDER BY cnt DESC LIMIT 30
  `).all();

  const sample = d.prepare(`
    SELECT file_path, start_line, end_line, metadata_json, SUBSTR(content, 1, 300) as snippet
    FROM chunks WHERE metadata_json != '{}' ORDER BY RANDOM() LIMIT 1
  `).get();

  const plainSample = d.prepare(`
    SELECT file_path, start_line, end_line, SUBSTR(content, 1, 300) as snippet
    FROM chunks WHERE metadata_json = '{}' AND LENGTH(content) > 50 ORDER BY RANDOM() LIMIT 1
  `).get();

  const dist = d.prepare(`
    SELECT
      CASE
        WHEN LENGTH(content) < 100 THEN '<100'
        WHEN LENGTH(content) < 300 THEN '100-300'
        WHEN LENGTH(content) < 500 THEN '300-500'
        WHEN LENGTH(content) < 1000 THEN '500-1K'
        ELSE '>1K'
      END as bucket,
      COUNT(*) as cnt
    FROM chunks GROUP BY bucket ORDER BY MIN(LENGTH(content))
  `).all();

  const guideMap = loadGuideMap();

  // 构建 files table
  const guideFiles = Object.entries(guideMap).map(([title, info]) => {
    const row = d.prepare("SELECT COUNT(*) as cnt, SUM(LENGTH(content)) as total FROM chunks WHERE file_path LIKE ?").get(`%${title.slice(0, 30)}%`);
    return { title, disease: info.disease || "", cnt: row?.cnt || 0, total: row?.total || 0 };
  }).filter(f => f.cnt > 0).sort((a, b) => b.cnt - a.cnt);

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>知识库分片可视化报告</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    background: #f5f5f7;
    color: #1d1d1f;
    padding: 32px;
    line-height: 1.6;
  }
  h1 { font-size: 28px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { color: #6e6e73; font-size: 14px; margin-bottom: 32px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 16px; margin-bottom: 32px; }
  .card {
    background: white; border-radius: 12px; padding: 20px;
    box-shadow: 0 1px 3px rgba(0,0,0,.08); border: 0.5px solid rgba(0,0,0,.06);
  }
  .card .num { font-size: 32px; font-weight: 600; color: #1d1d1f; }
  .card .label { font-size: 13px; color: #6e6e73; margin-top: 4px; }

  h2 { font-size: 18px; font-weight: 600; margin: 32px 0 16px; }

  table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  th { text-align: left; padding: 12px 16px; font-size: 12px; font-weight: 600; color: #6e6e73; text-transform: uppercase; letter-spacing: .05em; background: #fafafa; border-bottom: 0.5px solid #e8e8ed; }
  td { padding: 10px 16px; font-size: 13px; border-bottom: 0.5px solid #f0f0f2; }
  tr:last-child td { border-bottom: none; }

  .bar-cell { position: relative; }
  .bar { position: absolute; left: 16px; top: 8px; height: 20px; background: #e8f0fe; border-radius: 4px; opacity: .6; }
  .bar-text { position: relative; z-index: 1; }

  .chunk-sample { background: white; border-radius: 12px; padding: 20px; margin-bottom: 16px; box-shadow: 0 1px 3px rgba(0,0,0,.08); }
  .chunk-meta { font-size: 12px; color: #6e6e73; margin-bottom: 8px; }
  .chunk-meta span { margin-right: 16px; }
  .chunk-content { font-size: 13px; line-height: 1.7; color: #1d1d1f; white-space: pre-wrap; font-family: 'SF Mono', Menlo, monospace; background: #fafafa; padding: 16px; border-radius: 8px; }
  .chunk-content small { color: #6e6e73; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 4px; font-size: 11px; font-weight: 500; margin-right: 4px; }
  .badge-blue { background: #e8f0fe; color: #1967d2; }
  .badge-green { background: #e6f4ea; color: #137333; }
  .badge-gray { background: #f1f3f4; color: #5f6368; }
  .dist-bar { display: flex; gap: 4px; align-items: center; margin: 8px 0; }
  .dist-bar .seg { height: 24px; border-radius: 4px; min-width: 4px; background: #1967d2; }
  .dist-label { font-size: 12px; color: #6e6e73; }
</style>
</head>
<body>

<h1>知识库分片可视化报告</h1>
<p class="subtitle">pi-knowledge 知识库 "${d.prepare('SELECT name FROM knowledge_bases LIMIT 1').get()?.name || '医疗指南'}" · 生成于 ${new Date().toISOString().slice(0, 16)}</p>

<div class="cards">
  <div class="card"><div class="num">${total.toLocaleString()}</div><div class="label">总分片数</div></div>
  <div class="card"><div class="num">${totalFiles}</div><div class="label">源文件数</div></div>
  <div class="card"><div class="num">${(totalChars / 1000).toFixed(0)}KB</div><div class="label">总字符数</div></div>
  <div class="card"><div class="num">${avgLen}</div><div class="label">平均长度 (chars)</div></div>
</div>

<h2>分片长度分布</h2>
<div class="dist-bar">
  ${dist.map(b => `<div class="seg" style="flex: ${b.cnt / Math.max(...dist.map(x => x.cnt))}; background: #1967d2;"></div>`).join('')}
</div>
<div style="display: flex; gap: 16px; flex-wrap: wrap;">
  ${dist.map(b => `<span class="dist-label">${b.bucket}: ${b.cnt.toLocaleString()}</span>`).join('')}
</div>

<h2>文件分片排行榜 TOP 30</h2>
<table>
  <tr><th>#</th><th>文件</th><th>分片数</th><th>占比</th><th>均长</th><th>病种</th></tr>
  ${topFiles.map((f, i) => {
    const pct = (f.cnt / total * 100).toFixed(1);
    // 尝试匹配病种
    let disease = '';
    const fname = basename(f.file_path);
    for (const [title, info] of Object.entries(guideMap)) {
      if (fname.includes(title.slice(0, 20))) { disease = info.disease || ''; break; }
    }
    return `<tr>
      <td>${i + 1}</td>
      <td>${fname}</td>
      <td><div class="bar-cell"><div class="bar" style="width: ${pct}%"></div><span class="bar-text">${f.cnt}</span></div></td>
      <td>${pct}%</td>
      <td>${f.avgLen}B</td>
      <td>${disease ? `<span class="badge badge-blue">${disease}</span>` : '-'}</td>
    </tr>`;
  }).join('')}
</table>

<h2>分片样本</h2>

<h3 style="font-size: 14px; font-weight: 500; margin: 16px 0 8px; color: #6e6e73;">含 metadata 的分片</h3>
<div class="chunk-sample">
  ${sample ? `
  <div class="chunk-meta">
    <span>${sample.file_path}</span>
    <span>行 ${sample.start_line}-${sample.end_line}</span>
    <span>${JSON.parse(sample.metadata_json || '{}') ? Object.entries(JSON.parse(sample.metadata_json)).map(([k,v]) => `<span class="badge badge-green">${k}=${String(v).slice(0,30)}</span>`).join('') : '<span class="badge badge-gray">无 metadata</span>'}</span>
  </div>
  <div class="chunk-content">${(sample.snippet || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  ` : '<p style="color:#6e6e73;">无 metadata 样本</p>'}
</div>

<h3 style="font-size: 14px; font-weight: 500; margin: 16px 0 8px; color: #6e6e73;">纯文本分片（无 metadata）</h3>
<div class="chunk-sample">
  ${plainSample ? `
  <div class="chunk-meta">
    <span>${plainSample.file_path}</span>
    <span>行 ${plainSample.start_line}-${plainSample.end_line}</span>
  </div>
  <div class="chunk-content">${(plainSample.snippet || '').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
  ` : '<p style="color:#6e6e73;">无纯文本样本</p>'}
</div>

<h2>按病种浏览</h2>
<table>
  <tr><th>病种</th><th>指南数</th><th>分片数</th><th>字符数</th></tr>
  ${guideFiles.map(f => {
    const pct = (f.cnt / total * 100).toFixed(1);
    return `<tr>
      <td><strong>${f.disease}</strong></td>
      <td style="font-size:12px; color:#6e6e73;">${f.title.slice(0, 40)}...</td>
      <td><div class="bar-cell"><div class="bar" style="width: ${pct}%"></div><span class="bar-text">${f.cnt}</span></div></td>
      <td>${(f.total / 1000).toFixed(0)}KB</td>
    </tr>`;
  }).join('')}
</table>

<div style="margin-top: 48px; padding-top: 24px; border-top: 0.5px solid #e8e8ed; text-align: center; font-size: 12px; color: #6e6e73;">
  医疗 Agentic RAG · chunk-explorer 报告 · 数据来源: ${KNOWLEDGE_DB}
</div>

</body>
</html>`;

  const htmlPath = join(outDir, "chunk-report.html");
  writeFileSync(htmlPath, html, "utf-8");
  console.log(`✓ HTML 报告已生成: ${htmlPath}`);
}

function main() {
  const cmd = process.argv[2];
  const arg = process.argv[3];

  switch (cmd) {
    case "stats": cmdStats(); break;
    case "list": cmdList(); break;
    case "sample": cmdSample(); break;
    case "file": cmdFile(arg || ""); break;
    case "search": cmdSearch(arg || ""); break;
    case "disease": cmdDisease(arg || ""); break;
    case "html": cmdHtml(); break;
    default:
      console.log(`分片浏览器 — 知识库 chunk 查看工具

用法: node scripts/kb/inspect/chunk-explorer.mjs <command> [args]

命令:
  stats             概览统计
  list              文件分片排行榜
  sample            随机分片样本（含完整 metadata）
  file <path>       查看指定文件的分片列表
  search <词>        全文搜索分片
  disease <病种名>    按病种搜索分片
  html              生成可视化 HTML 报告（docs/chunk-report/）

示例:
  node scripts/kb/inspect/chunk-explorer.mjs stats
  node scripts/kb/inspect/chunk-explorer.mjs sample
  node scripts/kb/inspect/chunk-explorer.mjs search 高血压
  node scripts/kb/inspect/chunk-explorer.mjs disease 糖尿病
  node scripts/kb/inspect/chunk-explorer.mjs html`);
      process.exit(cmd ? 1 : 0);
  }
}

main();
