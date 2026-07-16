// content-need-alignment.mjs
// 第六维评测：内容-需求对齐度（content-need alignment）。
//
// 背景：既往评估体系（检索精度/答案质量/分片质量/忠实度/冲突）均聚焦「系统内部表现」，
// 从未回答「知识库内容覆盖是否真是系统所需」。本维度以 gold 评测集为「需求侧信号」，
// 以 kb-sources / guide-index / 真实 chunks 为「供给侧事实」，量化二者对齐程度。
//
// 六大指标：
//   1) realContentCoverage  源文件级可追溯覆盖率：需求侧依赖指南能否在 KB 真实 chunk 中
//      逐名定位到具体文件（目标 100%）。注意：这是「引用可追溯性」而非「病种主题覆盖」——
//      库中有同病种但异名/异版指南时，此项会判缺失（即溯源债），不代表该主题无内容。
//   2) versionStaleness      版本陈旧指数：guide-index 中 deprecated/superseded 并存组数（目标 0）
//   3) naiveNameMatchRate   朴素名匹配率：gtSource 人类名能否直接归一映射 KB 源名（溯源债）
//   4) demandCoverageDepth   需求侧覆盖深度：gold 点名源数 / 供给侧总源数
//   5) untestedBreadthRatio  未测广度占比：(总源数 - 被 gold 覆盖源数) / 总源数
//   6) indexCoverage         索引覆盖率：guide-index 已索引源 / kb-sources 总源
//
// 设计：纯函数全部接受注入数据，零 LLM、零 DB 依赖，供 tests/unit/content-need-alignment-test.mjs
// 原生 node 零 Key 单测；CLI 层负责读真实文件 + 直读 knowledge.db（better-sqlite3 动态候选路径）。
//
// 用法：
//   node scripts/kb/content-need-alignment.mjs                 # 评真实 KB
//   node scripts/kb/content-need-alignment.mjs --gold <p>      # 指定 gold
//   node scripts/kb/content-need-alignment.mjs --db <p>        # 指定 DB
//   node scripts/kb/content-need-alignment.mjs --out <p>       # 指定 JSON 输出（默认 tests/reports/）

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { betterSqlite3Candidates } from "../lib/config.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// 稳健解析项目根：从本文件目录向上递归找含 package.json 的目录。
function findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
const ROOT = findProjectRoot(__dirname);

// oversized 分片目录名 → 指南标题（人工短 key，镜像 scripts/kb/split_oversized.py 的 SRC）。
// 仅 3 份超大主 PDF 走此通道；废止指南均非 oversized，故该映射仅用于覆盖率「现行版」识别。
const OVERIZED_KEY_TO_TITLE = {
  罕见病2025: "86个罕见病病种诊疗指南（2025年版）",
  乳腺癌2025: "中国抗癌协会乳腺癌诊治指南与规范（2025年版）",
  肝癌2026: "原发性肝癌诊疗指南（2026版）",
};

// ---------- 归一（用于双向包含匹配）----------
/** 去扩展名、去括号差异、去空白，得到可比较的标题片段。 */
export function normTitle(s) {
  return String(s || "")
    .replace(/[\\/]/g, " ")
    .replace(/\.(pdf|txt|docx?|md)$/i, "")
    .replace(/[（）()]/g, "")
    .replace(/\s+/g, "")
    .trim();
}

// ---------- 需求侧：gold 依赖指南提取 ----------
/** 从 gold items 提取去重后的需求侧依赖指南名（gtSources 扁平化）。 */
export function extractDemandGuides(goldItems) {
  const set = new Set();
  for (const it of goldItems || []) {
    const ss = it && (it.gtSources || it.gtSource || it.sources || []);
    if (Array.isArray(ss)) for (const s of ss) if (s) set.add(String(s).trim());
    else if (typeof ss === "string" && ss.trim()) set.add(ss.trim());
  }
  return [...set];
}

// ---------- 供给侧：真实 chunk 落地的指南标题 ----------
/**
 * 从 DB chunk 的 file_path 反推其所属指南标题（纯函数，注入 chunkFilePaths 即可单测）。
 * 普通 chunk：裸 basename（去扩展名）；oversized：_oversized_split/<key>/part_NNN.pdf → 短 key 映射标题。
 */
export function extractRealCoveredTitles(chunkFilePaths) {
  const out = new Set();
  for (const fp of chunkFilePaths || []) {
    const s = String(fp);
    const m = s.match(/_oversized_split[/\\]([^/\\]+)[/\\]/);
    if (m) {
      const key = m[1];
      out.add(OVERIZED_KEY_TO_TITLE[key] || key);
    } else {
      const base = s.split(/[/\\]/).pop() || s;
      out.add(base.replace(/\.(pdf|txt|docx?|md)$/i, ""));
    }
  }
  return [...out];
}

// ---------- 指标 1：真实内容覆盖率 ----------
/**
 * 需求侧依赖指南在真实 chunk 中的落地比例。
 * @returns {{covered:number,total:number,rate:number,missing:string[]}}
 */
export function realContentCoverage(demandGuides, realCoveredTitles) {
  const real = (realCoveredTitles || []).map(normTitle);
  const realSet = new Set(real);
  const missing = [];
  let covered = 0;
  for (const d of demandGuides || []) {
    const nd = normTitle(d);
    const hit = realSet.has(nd) || real.some((r) => r.includes(nd) || nd.includes(r));
    if (hit) covered++;
    else missing.push(d);
  }
  const total = (demandGuides || []).length;
  return { covered, total, rate: total ? covered / total : 1, missing };
}

// ---------- 指标 2：版本陈旧指数 ----------
/** guide-index 中 deprecated/superseded 并存组数（P0 目标 0）。 */
export function versionStaleness(guideMap) {
  const items = [];
  for (const [title, meta] of Object.entries(guideMap || {})) {
    if (meta && (meta.deprecated || meta.supersededBy)) {
      items.push({ title, deprecated: !!meta.deprecated, supersededBy: meta.supersededBy || null });
    }
  }
  return { count: items.length, items };
}

// ---------- 指标 3：朴素名匹配率 + 源覆盖映射 ----------
/**
 * gtSource 人类名能否直接归一映射 KB 源名（双向包含）。
 * @returns {{matched:number,total:number,rate:number,unmatched:string[]}}
 */
export function naiveNameMatchRate(demandGuides, kbSourceNames) {
  const names = (kbSourceNames || []);
  const unmatched = [];
  let matched = 0;
  for (const d of demandGuides || []) {
    const nd = normTitle(d);
    const hit = names.some((n) => {
      const nn = normTitle(n);
      return nn === nd || nn.includes(nd) || nd.includes(nn);
    });
    if (hit) matched++;
    else unmatched.push(d);
  }
  const total = (demandGuides || []).length;
  return { matched, total, rate: total ? matched / total : 1, unmatched };
}

/** 被需求侧覆盖到的 KB 源名（去重），供未测广度计算。 */
export function matchedSourceNames(demandGuides, kbSourceNames) {
  const result = new Set();
  for (const d of demandGuides || []) {
    const nd = normTitle(d);
    for (const n of kbSourceNames || []) {
      const nn = normTitle(n);
      if (nn === nd || nn.includes(nd) || nd.includes(nn)) {
        result.add(n);
        break;
      }
    }
  }
  return [...result];
}

// ---------- 指标 4：需求侧覆盖深度 ----------
export function demandCoverageDepth(demandUniqueCount, kbSourceCount) {
  if (!kbSourceCount) return 0;
  return demandUniqueCount / kbSourceCount;
}

// ---------- 指标 5：未测广度占比 ----------
export function untestedBreadthRatio(matchedSourceCount, kbSourceCount) {
  if (!kbSourceCount) return 0;
  return (kbSourceCount - matchedSourceCount) / kbSourceCount;
}

// ---------- 指标 6：索引覆盖率 ----------
export function indexCoverage(guideMap, kbSources) {
  const total = kbSources && Array.isArray(kbSources.sources) ? kbSources.sources.length : 0;
  const indexed = Object.keys(guideMap || {}).length;
  return { indexed, total, rate: total ? indexed / total : 1 };
}

// ---------- 阈值与判定 ----------
function grade(rate, { pass = 1, warn = 0.9 }) {
  if (rate >= pass) return "PASS";
  if (rate >= warn) return "WARN";
  return "FAIL";
}

// ---------- 顶层装配 ----------
/**
 * 装配完整对齐度报告（纯函数，注入全部输入即可单测）。
 * @param {object} args
 * @param {Array} args.goldItems           gold 评测集 items
 * @param {object} args.kbSources          {sources:[{name,localPath,...}]}
 * @param {object} args.guideMap           guide-index 的 guideMap
 * @param {Array<string>} args.chunkFilePaths  真实 DB chunk 的 file_path 列表（可空 → 覆盖率降级）
 * @returns {object} 结构化报告（含 metrics / verdicts / overall）
 */
export function buildAlignmentReport({ goldItems, kbSources, guideMap, chunkFilePaths = [] }) {
  const demandGuides = extractDemandGuides(goldItems);
  const kbSourceNames = (kbSources && kbSources.sources ? kbSources.sources : []).map((s) => s.name || s.id || "");
  const realCovered = extractRealCoveredTitles(chunkFilePaths);

  const cov = realContentCoverage(demandGuides, realCovered);
  const stal = versionStaleness(guideMap);
  const nameMatch = naiveNameMatchRate(demandGuides, kbSourceNames);
  const matched = matchedSourceNames(demandGuides, kbSourceNames);
  const kbTotal = kbSourceNames.length;
  const depth = demandCoverageDepth(demandGuides.length, kbTotal);
  const untested = untestedBreadthRatio(matched.length, kbTotal);
  const idx = indexCoverage(guideMap, kbSources);

  const coverageVerdict = chunkFilePaths.length
    ? grade(cov.rate, { pass: 1, warn: 0.9 })
    : "SKIP"; // DB 不可用时覆盖率不卡点
  const stalVerdict = stal.count === 0 ? "PASS" : stal.count <= 3 ? "WARN" : "FAIL";
  const nameVerdict = grade(nameMatch.rate, { pass: 1, warn: 0.8 });
  const idxVerdict = grade(idx.rate, { pass: 0.9, warn: 0.7 });

  const metrics = {
    realContentCoverage: { ...cov, verdict: coverageVerdict },
    versionStaleness: { ...stal, verdict: stalVerdict },
    naiveNameMatchRate: { ...nameMatch, verdict: nameVerdict },
    demandCoverageDepth: { value: +depth.toFixed(4), demandGuides: demandGuides.length, kbSources: kbTotal, verdict: "INFO" },
    untestedBreadthRatio: { value: +untested.toFixed(4), matchedSources: matched.length, kbSources: kbTotal, verdict: "INFO" },
    indexCoverage: { ...idx, verdict: idxVerdict },
  };

  const rank = { PASS: 0, SKIP: 1, WARN: 2, FAIL: 3 };
  const worst = [metrics.realContentCoverage.verdict, metrics.versionStaleness.verdict, metrics.naiveNameMatchRate.verdict, metrics.indexCoverage.verdict]
    .sort((a, b) => rank[b] - rank[a])[0];
  const overall = worst || "PASS";

  return {
    generatedAt: new Date().toISOString(),
    metrics,
    overall,
    notes: [
      cov.missing.length ? `源文件溯源缺口 ${cov.missing.length} 项（gold 点名指南在 DB 无逐名对应 chunk——含真缺口或标题/版本异名，详见溯源债）` : "源文件级可追溯覆盖 100%",
      stal.count ? `版本陈旧 ${stal.count} 组（检索层已硬剔除，但 DB 仍并存废止 chunk，可经 kb:rebuild 清）` : "无版本陈旧",
      nameMatch.unmatched.length ? `溯源债 ${nameMatch.unmatched.length} 项（gtSource 名无法归一映射 KB 源名）` : "gtSource 名全部可映射",
      kbTotal ? `gold 仅点名 ${demandGuides.length}/${kbTotal} 源（${(untested * 100).toFixed(1)}% 广度未被需求信号覆盖）` : "",
    ].filter(Boolean),
  };
}

// ---------- CLI ----------
function loadBetterSqlite3() {
  const require = createRequire(import.meta.url);
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
  return null;
}

function readJsonSafe(p) {
  if (!p || !existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return null;
  }
}

function printReport(report) {
  const line = "=".repeat(64);
  console.log("\n" + line);
  console.log("  第六维 · 内容-需求对齐度评测");
  console.log(line);
  const rows = [
    ["真实内容覆盖率", report.metrics.realContentCoverage, `${report.metrics.realContentCoverage.covered}/${report.metrics.realContentCoverage.total} (${(report.metrics.realContentCoverage.rate * 100).toFixed(1)}%)`],
    ["版本陈旧指数", report.metrics.versionStaleness, `${report.metrics.versionStaleness.count} 组`],
    ["朴素名匹配率", report.metrics.naiveNameMatchRate, `${report.metrics.naiveNameMatchRate.matched}/${report.metrics.naiveNameMatchRate.total} (${(report.metrics.naiveNameMatchRate.rate * 100).toFixed(1)}%)`],
    ["需求侧覆盖深度", report.metrics.demandCoverageDepth, `${report.metrics.demandCoverageDepth.value}`],
    ["未测广度占比", report.metrics.untestedBreadthRatio, `${(report.metrics.untestedBreadthRatio.value * 100).toFixed(1)}%`],
    ["索引覆盖率", report.metrics.indexCoverage, `${report.metrics.indexCoverage.indexed}/${report.metrics.indexCoverage.total} (${(report.metrics.indexCoverage.rate * 100).toFixed(1)}%)`],
  ];
  for (const [name, m, val] of rows) {
    console.log(`  [${m.verdict.padEnd(4)}] ${name.padEnd(10)} ${val}`);
  }
  console.log(line);
  console.log("  总判定:", report.overall);
  for (const n of report.notes) console.log("   · " + n);
  console.log(line + "\n");
}

export async function main(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--gold") args.gold = argv[++i];
    else if (argv[i] === "--db") args.db = argv[++i];
    else if (argv[i] === "--out") args.out = argv[++i];
  }
  const goldPath = args.gold || join(ROOT, "tests", "gold-answers.json");
  const kbPath = join(ROOT, "data", "kb", "kb-sources.json");
  const giPath = join(ROOT, "data", "kb", ".guide-index.json");

  const gold = readJsonSafe(goldPath);
  const kbSources = readJsonSafe(kbPath);
  const gi = readJsonSafe(giPath);
  if (!gold || !kbSources || !gi) {
    console.error("✗ 输入文件缺失：gold/kb-sources/guide-index 任一读取失败");
    process.exit(1);
  }
  const goldItems = gold.items || gold.questions || (Array.isArray(gold) ? gold : []);
  const guideMap = gi.guideMap || gi;

  // 真实 chunk file_path
  let chunkFilePaths = [];
  let dbNote = "";
  let dbPath = args.db;
  if (!dbPath) {
    const cands = betterSqlite3Candidates().map((c) => c.replace(/better_sqlite3$/, "knowledge.db").replace(/lib[/\\]?$/, ""));
    // 退而求其次：从 homedir 推导标准位置
    const home = process.env.USERPROFILE || process.env.HOME || "";
    dbPath = join(home, ".pi", "knowledge", "knowledge.db");
  }
  const B = loadBetterSqlite3();
  if (B && existsSync(dbPath)) {
    try {
      const db = new B(dbPath, { readonly: true, fileMustExist: true });
      const rows = db.prepare("SELECT DISTINCT file_path FROM chunks").all();
      chunkFilePaths = rows.map((r) => r.file_path);
      db.close();
    } catch (e) {
      dbNote = "DB 读取失败，覆盖率降级 SKIP：" + (e?.message || e);
    }
  } else {
    dbNote = "better-sqlite3 不可用或 DB 缺失，覆盖率降级 SKIP";
  }

  const report = buildAlignmentReport({ goldItems, kbSources, guideMap, chunkFilePaths });
  if (dbNote) report.notes.push(dbNote);
  printReport(report);

  const out = args.out || join(ROOT, "tests", "reports", "content-need-alignment.json");
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(report, null, 2), "utf-8");
  console.log("JSON 报告已写入:", out);
  // 退出码：FAIL→1，其余→0（CI 可据此卡点覆盖率/名匹配）
  process.exit(report.overall === "FAIL" ? 1 : 0);
}

// 仅 CLI 直接调用时执行（argv[1] 解析为绝对 file URL 再比，兼容相对路径调用）
if (import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((e) => {
    console.error("运行异常:", e);
    process.exit(1);
  });
}
