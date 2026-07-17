// embed-compare.mjs
// e5-small vs bge-m3 嵌入质量对比评测 —— V2 改进版
//
// 方法：
//   1) 读取 gold 集 41 条查询
//   2) e5-small：调用 searchKnowledge 做真实系统检索，检查 gtSources 在 top-K 的命中率
//   3) bge-m3：全量嵌入 KB 所有 chunks，对每条查询做余弦相似度检索，检查 top-K 命中率
//   4) 汇总对比结果
//
// 运行: node scripts/eval/embed-compare.mjs
// 输出: 终端摘要 + data/embed-compare-v2-report.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { betterSqlite3Candidates } from "../lib/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const require = createRequire(import.meta.url);

// LM Studio bge-m3 端点
const EMBED_URL = "http://localhost:1234/v1/embeddings";
const EMBED_MODEL = "text-embedding-bge-m3";
const BATCH_SIZE = 5;   // 嵌入批大小（chunk 文本长，少批量防超时）
const TOP_K = 8;         // 评测 top-K 值

const embedCache = new Map();

// ---- 版本别名解析：gold 中的版本名 → KB 中实际文件名 ----
// gold 的 gtSources 可能标"2026版"，但 KB 中只有"2024年版"
const VERSION_ALIASES = {
  "（2026版）": "（2024年版）",
  "（2026年版）": "（2024年版）",
  "(2026年版)": "（2024年版）",
  "（2025年版）": "（2025年版）",
  "（2025版）": "（2025年版）",
  "（2024版）": "（2024年版）",
  "(2024年版)": "（2024年版）",
  "（2023年版）": "（2023年版）",
  "（2022年版）": "（2022年版）",
  "(2022年版)": "（2022年版）",
};

/** 根据 gold 的 gtSource 在 KB 中查找匹配的文件路径 */
function resolveFileInKb(db, goldSource) {
  // 尝试精确匹配
  const exact = db.prepare(
    "SELECT DISTINCT file_path FROM chunks WHERE file_path LIKE ? LIMIT 1"
  ).all(`%${goldSource}%`);
  if (exact.length) return exact[0].file_path;

  // 尝试版本别名匹配
  for (const [goldVer, kbVer] of Object.entries(VERSION_ALIASES)) {
    if (!goldSource.includes(goldVer)) continue;
    const alt = goldSource.replace(goldVer, kbVer);
    const altRow = db.prepare(
      "SELECT DISTINCT file_path FROM chunks WHERE file_path LIKE ? LIMIT 1"
    ).all(`%${alt}%`);
    if (altRow.length) return altRow[0].file_path;
  }

  // 去除括号内容 + 版本号，只保留指南名
  const bare = goldSource.replace(/[（(][^）)]*[）)]/g, "").trim().slice(0, 15);
  const fuzzy = db.prepare(
    "SELECT DISTINCT file_path FROM chunks WHERE file_path LIKE ? LIMIT 1"
  ).all(`%${bare}%`);
  return fuzzy.length ? fuzzy[0].file_path : null;
}

async function batchEmbed(texts) {
  if (!texts.length) return [];
  const results = new Array(texts.length);
  const uncachedTexts = [];
  const uncachedIdx = [];

  for (let i = 0; i < texts.length; i++) {
    const cached = embedCache.get(texts[i]);
    if (cached !== undefined) {
      results[i] = cached;
    } else {
      uncachedTexts.push(texts[i]);
      uncachedIdx.push(i);
    }
  }
  if (uncachedTexts.length === 0) return results;

  for (let i = 0; i < uncachedTexts.length; i += BATCH_SIZE) {
    const batch = uncachedTexts.slice(i, i + BATCH_SIZE);
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const resp = await fetch(EMBED_URL, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ model: EMBED_MODEL, input: batch }),
          signal: AbortSignal.timeout(30000),
        });
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const data = await resp.json();
        if (!data?.data?.length) throw new Error("空返回");
        for (let j = 0; j < data.data.length; j++) {
          const vec = data.data[j].embedding;
          results[uncachedIdx[i + j]] = vec;
          embedCache.set(batch[j], vec);
        }
        lastErr = null;
        break;
      } catch (e) {
        lastErr = e;
        if (attempt < 2) await new Promise(r => setTimeout(r, 2000 * (attempt + 1)));
      }
    }
    if (lastErr) throw lastErr;
    process.stdout.write(".");
    if ((i / BATCH_SIZE + 1) % 40 === 0) process.stdout.write(` ${i + batch.length}\n`);
  }
  return results;
}

function cosine(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function loadSqlite() {
  const candidates = betterSqlite3Candidates();
  for (const c of candidates) { try { const m = require(c); if (m) return m.default || m; } catch {} }
  throw new Error("better-sqlite3 不可用");
}

async function main() {
  console.log("=".repeat(56));
  console.log("  e5-small vs bge-m3 嵌入对比评测 V2");
  console.log("=".repeat(56));

  // 1) 加载 gold
  const gold = JSON.parse(readFileSync(join(ROOT, "tests", "gold-answers.json"), "utf-8"));
  const items = gold.items;
  console.log(`\n[1] gold 集: ${items.length} 条查询\n`);

  // 2) 连接 KB
  const Database = await loadSqlite();
  const dbPath = join(process.env.USERPROFILE || "", ".pi", "knowledge", "knowledge.db");
  if (!existsSync(dbPath)) { console.error("knowledge.db 未找到:", dbPath); process.exit(1); }
  const db = new Database(dbPath, { readonly: true });
  const totalChunks = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  console.log(`[2] KB: ${totalChunks} chunks\n`);

  // 3) 预加载 searchKnowledge
  let searchKnowledge;
  try {
    const mod = require(join(ROOT, ".pi", "extensions", "lib", "retrieval-router.mjs"));
    searchKnowledge = mod.searchKnowledge;
  } catch (e) {
    console.warn("searchKnowledge 加载失败（轻量模式），e5 部分跳过:", e.message);
  }

  // 4) 全量嵌入 KB chunks（或从缓存加载，支持断点续传）
  const CACHE_FILE = join(ROOT, "data", "embed-cache.json");
  let chunkVecs = null;

  console.log("[3] KB 全部 chunks 嵌入（bge-m3）...");
  const allChunks = db.prepare(
    "SELECT id, file_path, content FROM chunks ORDER BY rowid"
  ).all();

  if (existsSync(CACHE_FILE)) {
    try {
      const cached = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      if (cached.total === allChunks.length && cached.model === EMBED_MODEL) {
        chunkVecs = cached.vectors;
        console.log(`  从缓存加载: ${chunkVecs.length} 向量`);
      }
    } catch {}
  }

  let embedMs = null;  // 嵌入耗时（ms），缓存加载时为 null

  if (!chunkVecs) {
    console.log(`  共计 ${allChunks.length} chunks...`);
    const chunkTexts = allChunks.map(c => (c.content || "").slice(0, 800));
    const t0 = Date.now();
    chunkVecs = await batchEmbed(chunkTexts);
    embedMs = Date.now() - t0;
    console.log(`\n  嵌入完成，耗时 ${(embedMs / 1000).toFixed(0)}s`);
    try {
      writeFileSync(CACHE_FILE, JSON.stringify({ model: EMBED_MODEL, total: allChunks.length, vectors: chunkVecs, ts: Date.now() }), "utf-8");
      console.log(`  缓存已写入: ${CACHE_FILE}`);
    } catch (e) { console.warn(`  缓存写入失败: ${e.message}`); }
  }

  // 5) 评测所有 gold 条目
  console.log(`\n[4] 评测 ${items.length} 条 gold 查询...\n`);
  const results = [];
  let e5Hit = 0, e5Total = 0;
  let bgeHit = 0, bgeTotal = 0;

  for (const item of items) {
    const q = item.q;
    const gtSources = item.gtSources || [];

    // ---- 解析 KB 中对应文件 ----
    const kbFiles = [];
    for (const src of gtSources) {
      const f = resolveFileInKb(db, src);
      if (f) kbFiles.push(f);
    }

    // ---- e5-small 检索 ----
    let e5TopKFiles = [];
    if (searchKnowledge && q) {
      try {
        const e5Result = searchKnowledge(q, { limit: TOP_K });
        if (e5Result?.results) e5TopKFiles = e5Result.results.map(r => r.file_path);
      } catch (e) {
        // 静默跳过
      }
    }
    const e5Ok = kbFiles.length > 0 && e5TopKFiles.some(fp =>
      kbFiles.some(kf => fp && kf && (fp.includes(kf.slice(0, 20)) || kf.includes(fp.slice(0, 20))))
    );
    if (searchKnowledge) { e5Total++; if (e5Ok) e5Hit++; }

    // ---- bge-m3 检索 ----
    const [qVec] = await batchEmbed([q]);

    // 对所有 chunks 算相似度，取 top-K
    const simList = [];
    for (let i = 0; i < chunkVecs.length; i++) {
      const sim = cosine(qVec, chunkVecs[i]);
      simList.push({ sim, idx: i, file: allChunks[i].file_path });
    }
    simList.sort((a, b) => b.sim - a.sim);
    const bgeTopKFiles = simList.slice(0, TOP_K).map(r => r.file);

    const bgeOk = kbFiles.length > 0 && bgeTopKFiles.some(fp =>
      kbFiles.some(kf => fp && kf && (fp.includes(kf.slice(0, 20)) || kf.includes(fp.slice(0, 20))))
    );
    bgeTotal++; if (bgeOk) bgeHit++;

    results.push({
      id: item.id,
      q: q.slice(0, 40),
      gtSources,
      kbFiles,
      e5TopKFiles: e5TopKFiles.slice(0, 3).map(f => f?.slice(0, 30)),
      bgeTopKFiles: bgeTopKFiles.slice(0, 3).map(f => f?.slice(0, 30)),
      e5Hit: e5Ok,
      bgeHit: bgeOk,
      kbResolved: kbFiles.length > 0,
    });

    const e5m = searchKnowledge ? (e5Ok ? "✓" : "✗") : "—";
    process.stdout.write(`  ${item.id}: e5=${e5m} bge=${bgeOk ? "✓" : "✗"} → ${kbFiles[0]?.slice(0, 35) || "未匹配"}\n`);
  }

  db.close();

  // 6) 汇总
  console.log("\n" + "=".repeat(56));
  console.log("  对比结果");
  console.log("=".repeat(56));
  if (searchKnowledge) {
    console.log(`  e5-small (系统检索) top-${TOP_K} 召回: ${e5Hit}/${e5Total} = ${(e5Hit/e5Total*100).toFixed(1)}%`);
  } else {
    console.log("  e5-small: 跳过（searchKnowledge 未加载）");
  }
  console.log(`  bge-m3 (LM Studio) top-${TOP_K} 召回: ${bgeHit}/${bgeTotal} = ${(bgeHit/bgeTotal*100).toFixed(1)}%`);
  const embedTimeStr = embedMs !== null ? `${(embedMs / 1000).toFixed(0)}s` : "（缓存加载）";
  console.log(`  嵌入耗时: ${embedTimeStr}`);

  const report = {
    timestamp: new Date().toISOString(),
    embedModel: EMBED_MODEL,
    goldTotal: items.length,
    topK: TOP_K,
    embedTimeSec: embedMs !== null ? Math.round(embedMs / 1000) : -1,
    e5Recall: searchKnowledge ? { pass: e5Hit, total: e5Total, pct: e5Hit/e5Total } : null,
    bgeRecall: { pass: bgeHit, total: bgeTotal, pct: bgeHit/bgeTotal },
    details: results,
  };

  const outDir = join(ROOT, "data");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "embed-compare-v2-report.json"), JSON.stringify(report, null, 2), "utf-8");
  console.log(`\n报告已写入: data/embed-compare-v2-report.json`);
}

main().catch(e => { console.error("脚本失败:", e); process.exit(1); });
