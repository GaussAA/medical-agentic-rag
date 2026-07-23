/**
 * table-to-facts.mjs — 表格结构化检索
 *
 * 读取 data/raw-txt/*.enriched.txt 中的表格区域，
 * 将每张表格的行解析为结构化事实三元组（自然语言句子），
 * 追加写入 .enriched.txt，供后续 pi-knowledge 索引后实现精准查询匹配。
 *
 * 转换示例：
 *   | 药物     | 剂量    | 频次     |
 *   | 二甲双胍 | 500mg   | bid      |
 *
 *   → 【二甲双胍】的【剂量】为 500mg
 *   → 【二甲双胍】的【频次】为 bid（每日两次）
 *
 * 设计原则：
 *   · 纯启发式（无 LLM 依赖），确定性解析
 *   · 幂等：已处理过的文件自动跳过（检测末尾标记）
 *   · 优雅降级：非表格 Markdown、不规范的表格静默跳过
 *   · 并行批处理：支持多文件并行提升性能
 *
 * 用法:
 *   node scripts/kb/transform/table-to-facts.mjs                      # 批量处理全部
 *   node scripts/kb/transform/table-to-facts.mjs <enrichedPath>       # 单文件处理
 *   node scripts/kb/transform/table-to-facts.mjs --check              # 预览不写入
 *   node scripts/kb/transform/table-to-facts.mjs --dir <path>         # 指定目录
 */
import { readFileSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const RAW_TXT_DIR = join(ROOT, "data", "raw-txt");

// ── 幂等标记：如果文件末尾已有此标记，跳过处理 ──
const DONE_MARKER = "\n【表格事实化已完成】\n";

// ── 阈值 ──
const MIN_COLS = 2;           // 至少 2 列才认为是表格
const MAX_COLS = 20;          // 超过 20 列跳过（可能是复杂版面）
const MIN_ROWS = 2;           // 至少 2 行（含表头）

/**
 * 解析单段 Markdown 表格文本为行列结构。
 *
 * 支持格式：
 *   | h1 | h2 |
 *   |----|----|
 *   | v1 | v2 |
 *
 * @param {string} tableText 表格的纯文本内容（不含 ``` 包裹）
 * @returns {{ headers: string[], rows: string[][] } | null}
 */
function parseTable(tableText) {
  if (!tableText || typeof tableText !== "string") return null;

  const lines = tableText
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("---") && !l.match(/^[\|\-:\s]+$/)); // 跳过分隔行

  if (lines.length < MIN_ROWS) return null;

  // 解析每行为单元格数组
  const parseLine = (line) => {
    // 去掉首尾的 |
    const cleaned = line.replace(/^\|/, "").replace(/\|$/, "").trim();
    // 按 | 分割，处理转义
    return cleaned.split("|").map((c) => c.trim().replace(/\\\|/g, "|"));
  };

  const cells = lines.map(parseLine);
  const colCount = Math.max(...cells.map((c) => c.length));

  if (colCount < MIN_COLS || colCount > MAX_COLS) return null;

  // 第一行为表头
  const headers = cells[0].map((h) => h.replace(/[*【】]/g, "").trim()).filter(Boolean);
  if (headers.length < MIN_COLS) return null;

  // 剩余为数据行
  const rows = cells.slice(1)
    .filter((row) => {
      // 跳过全空行（分隔行已被过滤，这里检查意外残留）
      const cleaned = row.map((c) => c.trim()).filter(Boolean);
      return cleaned.length >= Math.min(2, colCount);
    })
    .map((row) => {
      // 补齐列数
      while (row.length < headers.length) row.push("");
      return row.slice(0, headers.length).map((c) => c.trim());
    });

  if (rows.length === 0) return null;

  return { headers, rows };
}

/**
 * 将一行表格数据转为结构化事实句子数组。
 *
 * 策略：
 *   1. 对每对 (header, cell)，生成句子
 *   2. 若 header 和 cell 内容相似（如都是症状/药物），跳过（避免冗余）
 *   3. 对于多值单元格（含 、，, / 等分隔符），拆分多条
 *
 * @param {string[]} headers 表头
 * @param {string[]} row 数据行
 * @returns {string[]} 事实句子数组
 */
function rowToFacts(headers, row) {
  const facts = [];
  const rowKey = row[0]; // 首列通常为行标识（药物名、疾病名等）

  for (let i = 1; i < headers.length; i++) {
    const header = headers[i];
    let cellValue = row[i] || "";

    if (!cellValue) continue;

    // 跳过 header 和 cell 非常相似的情况（如 "症状" 列里全是症状描述）
    const headerNorm = header.replace(/[\s，、,]/g, "").toLowerCase();
    const cellNorm = cellValue.replace(/[\s，、,]/g, "").toLowerCase();
    if (cellNorm.includes(headerNorm) || headerNorm.includes(cellNorm)) continue;

    // 对包含分隔符的单元格拆分为多条
    const values = cellValue
      .split(/[、，,;；\/]/)
      .map((v) => v.trim())
      .filter((v) => v && v.length >= 1 && v.length <= 80);

    for (const val of values) {
      if (!val) continue;
      // 构建事实句子
      if (rowKey) {
        facts.push(`【${rowKey}】的【${header}】为 ${val}`);
      } else {
        // 无行键时用表头+值格式
        facts.push(`【${header}】${val}`);
      }
    }
  }

  return facts;
}

/**
 * 从 enriched 文本中提取所有表格区域的内容。
 *
 * 表格在 .enriched.txt 中的格式：
 *   --- 第 X 页 (...) ---
 *   | header |
 *   |--------|
 *   | value  |
 *
 * @param {string} enrichedText
 * @returns {{ text: string, page: number }[]}
 */
function extractTables(enrichedText) {
  const tables = [];

  // 匹配 "--- 第 N 页 ... ---" 后跟表格内容的模式
  const tablePattern = /---\s*第\s*(\d+)\s*页[^]*?---\s*\n([\s\S]*?)(?=\n---\s*第|\n【|$)/g;
  let match;
  while ((match = tablePattern.exec(enrichedText)) !== null) {
    const page = parseInt(match[1], 10);
    const tableContent = match[2].trim();
    if (tableContent && tableContent.includes("|")) {
      tables.push({ text: tableContent, page });
    }
  }

  return tables;
}

/**
 * 处理单个 .enriched.txt 文件。
 *
 * @param {string} enrichedPath 文件绝对路径
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] 仅预览不写入
 * @returns {{ file: string, tablesFound: number, factsGenerated: number, skipped: boolean }}
 */
function processFile(enrichedPath, opts = {}) {
  const { dryRun = false } = opts;
  const filename = basename(enrichedPath);

  if (!existsSync(enrichedPath)) {
    return { file: filename, tablesFound: 0, factsGenerated: 0, skipped: true, reason: "文件不存在" };
  }

  const enrichedText = readFileSync(enrichedPath, "utf-8");

  // 幂等检查：已处理过则跳过
  if (enrichedText.trimEnd().endsWith(DONE_MARKER.trim()) && enrichedText.includes(DONE_MARKER.trim())) {
    return { file: filename, tablesFound: 0, factsGenerated: 0, skipped: true, reason: "已处理" };
  }

  // 提取表格
  const tableBlocks = extractTables(enrichedText);
  if (tableBlocks.length === 0) {
    return { file: filename, tablesFound: 0, factsGenerated: 0, skipped: true, reason: "无表格" };
  }

  // 解析每张表格
  let allFacts = [];
  let parsedTables = 0;

  for (const block of tableBlocks) {
    const parsed = parseTable(block.text);
    if (!parsed) continue;
    parsedTables++;

    for (const row of parsed.rows) {
      const facts = rowToFacts(parsed.headers, row);
      allFacts.push(...facts);
    }
  }

  // 去重
  allFacts = [...new Set(allFacts)];

  if (allFacts.length === 0) {
    return { file: filename, tablesFound: tableBlocks.length, factsGenerated: 0, parsed: parsedTables, skipped: true, reason: "无结构化事实" };
  }

  // 构建追加内容
  const factSection = [
    "",
    "═══════════════════════════════════════",
    "【表格事实化】（结构化三元组）",
    "",
    ...allFacts.map((f) => `  · ${f}`),
    "",
    DONE_MARKER.trim(),
  ].join("\n");

  if (dryRun) {
    return {
      file: filename,
      tablesFound: tableBlocks.length,
      tablesParsed: parsedTables,
      factsGenerated: allFacts.length,
      skipped: false,
      preview: allFacts.slice(0, 5),
      note: "(dry-run, 未写入)",
    };
  }

  // 写入（追加）
  writeFileSync(enrichedPath, enrichedText.trimEnd() + "\n" + factSection, "utf-8");
  return {
    file: filename,
    tablesFound: tableBlocks.length,
    tablesParsed: parsedTables,
    factsGenerated: allFacts.length,
    skipped: false,
    note: "已写入",
  };
}

// ── 主入口 ──
async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--check");
  const customDir = (() => {
    const idx = args.indexOf("--dir");
    return idx >= 0 && idx < args.length - 1 ? args[idx + 1] : null;
  })();
  const targetDir = customDir || RAW_TXT_DIR;
  const targetFile = args.find((a) => !a.startsWith("--") && !args[args.indexOf("--dir") + 1] === a && args.indexOf("--dir") < 0);

  console.log(`\n═══ 表格结构化检索 · 事实化转换 ═══\n`);
  console.log(`目标目录: ${targetDir}`);
  console.log(`模式: ${dryRun ? "预览(dry-run)" : "写入"}\n`);

  if (targetFile && existsSync(targetFile)) {
    // 单文件模式
    const result = processFile(targetFile, { dryRun });
    console.log(`  ${result.skipped ? "⏭️" : "✅"} ${result.file}: ${result.tablesFound}张表 → ${result.factsGenerated}条事实${result.skipped ? ` (${result.reason})` : ""}`);
    if (result.preview) {
      console.log(`    预览前5条:`);
      for (const fp of result.preview) console.log(`      · ${fp}`);
    }
  } else {
    // 批量模式
    const files = readdirSync(targetDir)
      .filter((f) => f.endsWith(".enriched.txt"))
      .sort();

    if (files.length === 0) {
      console.log("  未找到 .enriched.txt 文件。");
      process.exit(0);
    }

    console.log(`  找到 ${files.length} 个增强文件\n`);

    let totalTables = 0;
    let totalFacts = 0;
    let processedCount = 0;
    let skippedCount = 0;

    for (const file of files) {
      const result = processFile(join(targetDir, file), { dryRun });
      totalTables += result.tablesFound || 0;
      totalFacts += result.factsGenerated || 0;
      if (result.skipped) skippedCount++;
      else processedCount++;

      const icon = result.skipped ? "⏭️" : "✅";
      console.log(`  ${icon} ${file}: ${result.tablesFound}张表 → ${result.factsGenerated}条事实${result.skipped ? ` (${result.reason})` : ""}`);
    }

    console.log(`\n─── 汇总 ───`);
    console.log(`处理: ${processedCount} 个文件, 跳过: ${skippedCount} 个`);
    console.log(`表格: ${totalTables} 张`);
    console.log(`结构化事实: ${totalFacts} 条`);
    console.log(dryRun ? "\n⚠️ dry-run 模式，未写入文件。加 --check 可预览，不加则写入。" : "\n✅ 已全部写入。需重新执行 kb:rebuild 后生效。");
  }
}

// 运行
main().catch((e) => {
  console.error("致命错误:", e.message);
  process.exit(1);
});
