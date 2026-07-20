// chunk-quality.mjs
// 分片质量评测（维度②补全：文档分片/索引质量独立量化）。
//
// 背景：原评估体系五环中，知识库质量/检索精度/答案质量均有量化，唯独
// 「文档分片质量」仅有章节结构计数（extract-outline），无 chunk 级语义质量度量。
// 本项目 chunk 由 pi-knowledge 内部切块，但 chunks 表（content / content_tokenized /
// start_line / end_line / metadata_json）真实落库于 ~/.pi/knowledge/knowledge.db，
// 故本脚本**只读直读真实 chunks**，产出可卡点的硬指标，不重新切块、不烧 LLM。
//
// 四项指标：
//   1) sizeStats      分片规模分布（字符数，过小失上下文/过大失精度）
//   2) referenceLocatability  证据可定位率（gold evidencePhrases 能否在单 chunk 完整命中）
//   3) entityFragmentation    医学实体跨片切断率（数值+单位/药物+剂量 被边界腰斩）
//   4) sectionContext         层级归属完整度（chunk 是否携带所属章节标题上下文）
//
// 用法：
//   node scripts/kb/chunk-quality.mjs                 # 评真实 knowledge.db
//   node scripts/kb/chunk-quality.mjs --db <path>     # 指定 DB
//   node scripts/kb/chunk-quality.mjs --gold <path>   # 指定 gold（默认 tests/gold-answers.json）
//   node scripts/kb/chunk-quality.mjs --report <path> # 指定报告输出
//
// 纯 .mjs 双可测：所有纯函数接受注入数据，供 tests/unit/chunk-quality-test.mjs 原生 node 单测。

import { createRequire } from "node:module";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { betterSqlite3Candidates } from "../lib/config.mjs"; // P0-1 修复：路径由 env/homedir 推导，灭用户名写死
import { isHeadingLine } from "../lib/chinese-heading.mjs"; // P1#5 统一中文层级标题判定

const __dirname = dirname(fileURLToPath(import.meta.url));

// 稳健解析项目根：从本文件目录向上递归找含 package.json 的目录。
// 不依赖固定的 "../.." 层数（scripts/kb → 实际隔 2 层，曾因写 3 层越过项目根落到父目录）。
function findProjectRoot(startDir) {
  let dir = startDir;
  // 上限 8 层，防死循环
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break; // 已到盘符根
    dir = parent;
  }
  return startDir; // 兜底：找不到就回退到本文件目录
}
const ROOT = findProjectRoot(__dirname);

// ---------- better-sqlite3 动态加载（与 retrieval-router 同候选路径）----------
function loadBetterSqlite3() {
  const require = createRequire(import.meta.url);
  // 候选人全部经 config.betterSqlite3Candidates() 由 env / homedir 推导，不再写死用户名。
  const candidates = betterSqlite3Candidates();
  let lastErr;
  for (const c of candidates) {
    try {
      const mod = require(c);
      if (mod) return mod.default || mod;
    } catch (e) {
      lastErr = e;
    }
  }
  return null; // 不抛：CLI 层据此友好提示（单测走注入，不依赖真实 DB）
}

// ---------- 分片规模分布 ----------
/**
 * 分片字符规模统计。
 * @param {Array<{content:string}>} chunks
 * @returns {{count:number,min:number,max:number,mean:number,median:number,p95:number,small:number,large:number,hist:Array<{bucket:string,count:number}>}}
 *   small = 字符数 <200（易失上下文）  large = >1500（易失精度）
 */
export function sizeStats(chunks) {
  const lens = chunks.map((c) => (c.content || "").length).sort((a, b) => a - b);
  const n = lens.length;
  if (n === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, median: 0, p95: 0, small: 0, large: 0, hist: [] };
  }
  const sum = lens.reduce((a, b) => a + b, 0);
  const pct = (p) => lens[Math.min(n - 1, Math.floor((p / 100) * n))];
  // 直方图桶（字符）
  const edges = [0, 200, 400, 600, 800, 1000, 1200, 1500, 2000, Infinity];
  const labels = ["<200", "200-400", "400-600", "600-800", "800-1000", "1000-1200", "1200-1500", "1500-2000", "2000+"];
  const hist = labels.map((b) => ({ bucket: b, count: 0 }));
  for (const l of lens) {
    for (let i = 0; i < edges.length - 1; i++) {
      if (l >= edges[i] && l < edges[i + 1]) {
        hist[i].count++;
        break;
      }
    }
  }
  return {
    count: n,
    min: lens[0],
    max: lens[n - 1],
    mean: +(sum / n).toFixed(1),
    median: pct(50),
    p95: pct(95),
    small: lens.filter((l) => l < 200).length,
    large: lens.filter((l) => l > 1500).length,
    hist,
  };
}

// ---------- 证据可定位率 ----------
/**
 * 证据可定位率：gold evidencePhrases 能否在**单个 chunk** 完整命中（不被边界切断）。
 * @param {Array<{content:string}>} chunks
 * @param {string[]} phrases  gold 证据短语（原文子串）
 * @returns {{total:number,located:number,rate:number,missing:string[]}}
 *   located = 至少命中一个 chunk 完整 content 的短语数
 */
export function referenceLocatability(chunks, phrases = []) {
  const corpus = chunks.map((c) => c.content || "");
  const missing = [];
  let located = 0;
  for (const ph of phrases) {
    if (!ph || !ph.trim()) continue;
    const hit = corpus.some((t) => t.includes(ph));
    if (hit) located++;
    else missing.push(ph);
  }
  const total = phrases.filter((p) => p && p.trim()).length;
  return {
    total,
    located,
    rate: total === 0 ? null : +(located / total).toFixed(3),
    missing: missing.slice(0, 50),
  };
}

// ---------- 医学实体跨片切断率 ----------
// 检测「数值(剂量/频次/周期)+单位」或「药物名+剂量」被 chunk 边界腰斩。
// 规则：上一 chunk 以「纯数值(可带小数点)」结尾、下一 chunk 以「单位词(mg/g/ml/次/周/天/岁/u/IU/mmol)」开头，
//       或反之（避免误报；只记明确的「数·单位」分离）。
// 单位分「复合单位」(mg/kg、mg/d、ml/min，含斜杠) 与「单单位」(mg、g…) 两类：
//   \b 在斜杠后失效，故复合单位单独用不含 \b 的前缀匹配，避免整体失配。
const COMPOUND_UNIT_RE = /^(mg\/kg|mg\/d|g\/d|ml\/min|mg\/kg\/d|μg\/kg|iu\/kg)/i;
const UNIT_RE = /^(mg|g|ml|μg|ug|iu|u|mmol|mol|次|周|天|日|岁|月|片)\b/i;
const NUM_END_RE = /(\d+(?:\.\d+)?)\s*$/;
const NUM_START_RE = /^\s*(\d+(?:\.\d+)?)/;

/** 下一 chunk 是否以单位（复合或单）开头，返回匹配的单位串或 null。 */
function matchUnitStart(text) {
  const t = (text || "").trim();
  const c = t.match(COMPOUND_UNIT_RE);
  if (c) return c[1];
  const s = t.match(UNIT_RE);
  if (s) return s[1];
  return null;
}
/** 上一 chunk 是否以单位（复合或单）结尾，返回匹配的单位串或 null。 */
function matchUnitEnd(text) {
  const t = (text || "").trim();
  const c = t.match(/(mg\/kg|mg\/d|g\/d|ml\/min|mg\/kg\/d|μg\/kg|iu\/kg)\s*$/i);
  if (c) return c[1];
  const s = t.match(/(\bmg|g|ml|μg|ug|iu|u|mmol|mol|次|周|天|日|岁|月|片)\s*$/i);
  if (s) return s[1];
  return null;
}
/**
 * 医学实体跨片切断率。
 * @param {Array<{content:string,file_path?:string}>} chunks  需按文件内顺序（默认按数组序；真实数据已按 start_line 近似有序）
 * @returns {{pairs:number,fragmented:number,rate:number,examples:string[]}}
 */
export function entityFragmentation(chunks) {
  let pairs = 0;
  let fragmented = 0;
  const examples = [];
  // 遍历所有相邻 chunk 对（i 与 i+1），覆盖 N 个 chunk 的 N-1 个边界。
  for (let i = 0; i < chunks.length - 1; i++) {
    const prev = (chunks[i].content || "").trim();
    const cur = (chunks[i + 1].content || "").trim();
    if (!prev || !cur) continue;
    pairs++; // 每个相邻边界都计为一个 pair（指标分母 = 全部边界）
    const prevNum = prev.match(NUM_END_RE);
    const curUnit = matchUnitStart(cur);
    const curNum = cur.match(NUM_START_RE);
    const prevUnit = matchUnitEnd(prev);
    // 情况A：上一片尾数值 + 下一片头单位
    if (prevNum && curUnit) {
      fragmented++;
      if (examples.length < 10) examples.push(`${prevNum[1]}‖${curUnit}（跨片：${prev.slice(-12)} | ${cur.slice(0, 12)}）`);
    }
    // 情况B：上一片尾单位 + 下一片头数值（倒置切割）
    else if (prevUnit && curNum) {
      fragmented++;
      if (examples.length < 10) examples.push(`${prevUnit}‖${curNum[1]}（跨片：${prev.slice(-12)} | ${cur.slice(0, 12)}）`);
    }
  }
  return {
    pairs,
    fragmented,
    rate: pairs === 0 ? 0 : +(fragmented / pairs).toFixed(4),
    examples,
  };
}

// ---------- 层级归属完整度 ----------
// 章节标题判定已迁至 scripts/lib/chinese-heading.mjs（isHeadingLine，含全角１．分支）
/**
 * 层级归属完整度：chunk 是否携带所属章节标题上下文。
 * 判定：chunk 首行（trim 后）命中章节标题正则 → 视为带上下文；否则视为 orphan（可能丢失层级归属）。
 * @param {Array<{content:string}>} chunks
 * @returns {{total:number,withSection:number,orphan:number,orphanRate:number}}
 */
export function sectionContext(chunks) {
  let withSection = 0;
  for (const c of chunks) {
    const firstLine = (c.content || "").split("\n").map((s) => s.trim()).find((s) => s.length > 0);
    if (firstLine && isHeadingLine(firstLine)) withSection++;
  }
  const total = chunks.length;
  const orphan = total - withSection;
  return {
    total,
    withSection,
    orphan,
    orphanRate: total === 0 ? 0 : +(orphan / total).toFixed(4),
  };
}

// ---------- 聚合 ----------
export function evaluateChunks(chunks, { phrases = [] } = {}) {
  return {
    generatedAt: new Date().toISOString(),
    size: sizeStats(chunks),
    referenceLocatability: referenceLocatability(chunks, phrases),
    entityFragmentation: entityFragmentation(chunks),
    sectionContext: sectionContext(chunks),
  };
}

// ---------- 读取真实 chunks ----------
function resolveKbDbPath() {
  const env = process.env.PI_KNOWLEDGE_DIR || process.env.PICODING_KNOWLEDGE_DIR;
  if (env) return join(env, "knowledge.db");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  return home ? join(home, ".pi", "knowledge", "knowledge.db") : null;
}

function loadChunksFromDb(dbPath) {
  const Database = loadBetterSqlite3();
  if (!Database) {
    throw new Error("better-sqlite3 不可用（pi-knowledge 未安装？），无法直读真实 chunks。");
  }
  if (!existsSync(dbPath)) throw new Error(`knowledge.db 不存在: ${dbPath}`);
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    // 按 file_path + start_line 排序，尽量还原文件内顺序（跨片切断检测依赖相邻序）
    const rows = db
      .prepare("SELECT content, file_path, start_line FROM chunks WHERE content IS NOT NULL ORDER BY file_path, start_line")
      .all();
    return rows;
  } finally {
    db.close();
  }
}

function loadGoldPhrases(goldPath) {
  if (!goldPath || !existsSync(goldPath)) return [];
  try {
    const d = JSON.parse(readFileSync(goldPath, "utf-8"));
    const items = Array.isArray(d) ? d : d.items || [];
    const phrases = [];
    for (const it of items) {
      if (Array.isArray(it.evidencePhrases)) phrases.push(...it.evidencePhrases);
    }
    return [...new Set(phrases.filter(Boolean))];
  } catch {
    return [];
  }
}

// ---------- CLI ----------
function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === "--db" && argv[i + 1]) a.db = argv[++i];
    else if (argv[i] === "--gold" && argv[i + 1]) a.gold = argv[++i];
    else if (argv[i] === "--report" && argv[i + 1]) a.report = argv[++i];
  }
  return a;
}

function printSummary(r) {
  const line = "─".repeat(60);
  console.log(line);
  console.log("医疗 Agentic RAG · 分片质量评测");
  console.log(line);
  const s = r.size;
  console.log(`分片总数: ${s.count}`);
  console.log(`字符规模: min=${s.min} median=${s.median} mean=${s.mean} p95=${s.p95} max=${s.max}`);
  console.log(`  过小(<200): ${s.small}  过大(>1500): ${s.large}`);
  const rl = r.referenceLocatability;
  console.log(`证据可定位率: ${rl.total ? (rl.rate * 100).toFixed(1) + "%" : "N/A(无gold短语)"}  (${rl.located}/${rl.total})`);
  const ef = r.entityFragmentation;
  console.log(`实体跨片切断率: ${(ef.rate * 100).toFixed(2)}%  (切断 ${ef.fragmented}/${ef.pairs} 边界对)`);
  const sc = r.sectionContext;
  console.log(`层级归属完整度: 带章节上下文 ${sc.withSection}/${sc.total}  orphan=${sc.orphan} (${(sc.orphanRate * 100).toFixed(1)}%)`);
  console.log(line);
}

const isMain =
  !!process.argv[1] &&
  basename(import.meta.url) === basename("file://" + (process.argv[1] || "").replace(/\\/g, "/"));
if (isMain) {
  try {
    const args = parseArgs(process.argv);
    const dbPath = args.db || resolveKbDbPath();
    const goldPath = args.gold || join(ROOT, "tests", "gold-answers.json");
    const reportPath =
      args.report || join(ROOT, "tests", "reports", "chunk-quality-report.json");
    const chunks = loadChunksFromDb(dbPath);
    const phrases = loadGoldPhrases(goldPath);
    const report = evaluateChunks(chunks, { phrases });
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf-8");
    printSummary(report);
    console.log(`报告已写出: ${reportPath}`);
  } catch (e) {
    console.error("[chunk-quality] 失败:", e.message);
    process.exit(1);
  }
}
