// pdf-enrich.mjs
// PDF 增强管道 —— 表格提取 + 质量检测 + OCR 兜底。
//
// 将增强后的文本写入 data/raw-txt/，作为原有 pdftotext 输出的补充。
// 增强后的文本以 `{basename}.enriched.txt` 命名，内容格式：
//   表格区域用 ```table ... ``` 包裹
//   OCR 文本在文件末尾添加 [OCR 补充] 段落
//
// 依赖: Python + pdfplumber + pdfminer.six（pip install）
// 可选: Tesseract OCR + pytesseract（需额外安装）
//
// 用法:
//   node scripts/kb/enrich/pdf-enrich.mjs <pdfPath>          单文件增强
//   node scripts/kb/enrich/pdf-enrich.mjs --batch            批量增强 data/raw/ 中全部 PDF
//   node scripts/kb/enrich/pdf-enrich.mjs --check            仅检查质量,不写入
//   node scripts/kb/enrich/pdf-enrich.mjs --install-deps     打印依赖安装指南

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RAW_DIR = join(ROOT, "data", "raw");
const RAW_TXT_DIR = join(ROOT, "data", "raw-txt");
const PY_SCRIPT = join(ROOT, "scripts", "kb", "enrich", "_pdf_enrich.py");
const PYTHON = process.env.PYTHON_PATH || "python";

function findPdfFiles() {
  const files = readdirSync(RAW_DIR);
  return files
    .filter((f) => f.endsWith(".pdf") && !f.startsWith("_"))
    .sort();
}

function getTxtPath(pdfName) {
  const name = basename(pdfName, ".pdf");
  return join(RAW_TXT_DIR, name + ".txt");
}

function getEnrichedTxtPath(pdfName) {
  const name = basename(pdfName, ".pdf");
  return join(RAW_TXT_DIR, name + ".enriched.txt");
}

/**
 * 运行 Python 增强脚本。
 */
function runPython(pdfPath, flags = []) {
  const args = [PY_SCRIPT, pdfPath, ...flags];
  const result = spawnSync(PYTHON, args, {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 60000,
  });

  if (result.error) {
    return { error: `Python 执行失败: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { error: `Python 退出码 ${result.status}: ${result.stderr?.slice(0, 500)}` };
  }

  try {
    return JSON.parse(result.stdout);
  } catch (e) {
    return { error: `JSON 解析失败: ${e.message}`, stdout: result.stdout?.slice(0, 500) };
  }
}

/**
 * 将增强结果写入 .enriched.txt。
 * 格式：保留原始 txt 内容 + 表格区域 + OCR 补充。
 */
function writeEnriched(pdfName, tables, ocrText, fallbackText) {
  const txtPath = getTxtPath(pdfName);
  const enrichedPath = getEnrichedTxtPath(pdfName);

  const parts = [];

  // 原始内容（pdftotext 输出）
  if (existsSync(txtPath)) {
    parts.push(readFileSync(txtPath, "utf-8").trim());
  } else if (fallbackText) {
    parts.push(fallbackText.trim());
  }

  // 表格区域
  if (tables && tables.length > 0) {
    parts.push("");
    parts.push("═══════════════════════════════════════");
    parts.push("【PDF 表格提取】");
    parts.push("");
    for (const tbl of tables) {
      parts.push(`--- 第 ${tbl.page} 页 (${tbl.rows} 行 × ${tbl.cols} 列) ---`);
      parts.push(tbl.text);
      parts.push("");
    }
    parts.push("═══════════════════════════════════════");
  }

  // OCR 补充
  if (ocrText && ocrText.length > 100) {
    parts.push("");
    parts.push("【OCR 补充】（扫描页文字识别）");
    parts.push(ocrText);
  }

  writeFileSync(enrichedPath, parts.join("\n"), "utf-8");
  return enrichedPath;
}

async function main() {
  const args = process.argv.slice(2);
  const target = args[0];
  const flags = args.filter((a) => a.startsWith("--"));

  if (flags.includes("--install-deps")) {
    console.log(`依赖安装指南:

Python 包（必选）:
  pip install pdfplumber pdfminer.six

OCR 兜底（可选，需额外安装 Tesseract）:
  1. 安装 Tesseract: https://github.com/UB-Mannheim/tesseract/wiki
  2. 安装中文语言包（chi_sim）
  3. pip install pytesseract Pillow pypdfium2

环境变量:
  PYTHON_PATH      自定义 Python 路径（默认 "python"）
  TESSERACT_CMD    Tesseract 可执行文件路径（Windows 需要）
`);
    process.exit(0);
  }

  if (target === "--batch") {
    const pdfFiles = findPdfFiles();
    console.log(`批量增强: ${pdfFiles.length} 个 PDF\n`);

    let enriched = 0, skipped = 0, errors = 0;
    for (const pdf of pdfFiles) {
      const pdfPath = join(RAW_DIR, pdf);
      const enrichedPath = getEnrichedTxtPath(pdf);

      // 已存在增强文件则跳过
      if (existsSync(enrichedPath) && !flags.includes("--force")) {
        skipped++;
        continue;
      }

      process.stdout.write(`  [${pdf}] `);
      const result = runPython(pdfPath, ["--tables", "--ocr", "--check-quality"]);

      if (result.error) {
        console.log(`✗ ${result.error}`);
        errors++;
        continue;
      }

      const hasTables = (result.tables || []).length > 0;
      const hasOcr = result.ocr?.available && result.ocr?.text && result.ocr.text.length > 100;
      const lowQuality = result.quality?.low_quality;

      if (hasTables || hasOcr || lowQuality) {
        writeEnriched(pdf, result.tables || [], result.ocr?.text || null, result.fallback_text || null);
        enriched++;
        const tags = [];
        if (hasTables) tags.push(`${result.table_count} 表`);
        if (hasOcr) tags.push("OCR");
        if (lowQuality) tags.push("低质量");
        console.log(`✓ 增强 (${tags.join(", ")})`);
      } else {
        skipped++;
        console.log(`· 无需增强`);
      }
    }

    console.log(`\n完成: ${enriched} 增强, ${skipped} 跳过, ${errors} 错误`);
    process.exit(errors > 0 ? 1 : 0);
  }

  if (target === "--check") {
    const pdfFiles = findPdfFiles();
    let low = 0, total = 0;
    console.log("PDF 质量检查:\n");
    for (const pdf of pdfFiles) {
      const pdfPath = join(RAW_DIR, pdf);
      const result = runPython(pdfPath, ["--check-quality"]);
      total++;
      if (result.error) {
        console.log(`  ⚠ [${pdf}] 检测失败: ${result.error.slice(0, 120)}`);
        continue;
      }
      if (result.quality) {
        const q = result.quality;
        const mark = q.low_quality ? "⚠ 低质量" : "✓";
        console.log(`  ${mark} [${pdf}] CJK=${(q.cjk_ratio * 100).toFixed(0)}% 字符=${q.total_chars}`);
        if (q.low_quality) low++;
      }
    }
    console.log(`\n共 ${total} 个 PDF, 低质量 ${low} 个 (${(low / total * 100).toFixed(0)}%)`);
    process.exit(0);
  }

  // 单文件增强
  if (target && existsSync(target)) {
    const pdfPath = target;
    const name = basename(pdfPath);
    console.log(`单文件增强: ${name}`);
    const result = runPython(pdfPath, ["--tables", "--ocr", "--check-quality"]);

    if (result.error) {
      console.error(`✗ ${result.error}`);
      process.exit(1);
    }

    const enrichedPath = writeEnriched(name, result.tables || [], result.ocr?.text || null, result.fallback_text || null);
    console.log(`✓ 增强文件已写入: ${enrichedPath}`);
    if (result.tables?.length) console.log(`  表格: ${result.tables.length} 个`);
    if (result.ocr?.available) console.log(`  OCR: 已应用`);
    if (result.quality?.low_quality) console.log(`  ⚠ 原始提取质量偏低，已补充`);
    process.exit(0);
  }

  console.log(`PDF 增强管道

用法: node scripts/kb/enrich/pdf-enrich.mjs <command>

命令:
  <pdfPath>            单文件增强（输出 .enriched.txt）
  --batch              批量增强 data/raw/ 中全部 PDF
  --check              质量普查（不写入）
  --install-deps       打印依赖安装指南
  --force              强制覆盖已有 .enriched.txt

说明:
  - 表格提取: 用 pdfplumber 结构化提取 → 写入 .enriched.txt
  - OCR 兜底: 扫描件文字识别（需安装 Tesseract + pytesseract）
  - 增强文件不影响原有 pdftotext 输出，互不覆盖`);
}

main().catch((err) => {
  console.error("[pdf-enrich] 失败:", err);
  process.exit(1);
});
