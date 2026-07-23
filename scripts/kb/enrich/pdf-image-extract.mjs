/**
 * pdf-image-extract.mjs — PDF 图片提取 + 上下文描述注入
 *
 * 流程：
 *   1. 用 _pdf_extract_images.py 从 PDF 中提取图片
 *   2. 提取每张图片所在页面的文本上下文（从 pdftotext 输出或 .enriched.txt）
 *   3. 构建图片描述文本（含上下文 + 图片路径信息）
 *   4. 将图片描述追加写入 .enriched.txt，供 pi-knowledge 索引
 *
 * 效果：用户检索"糖尿病治疗路径""高血压诊断流程图"等查询时，
 * 能召回关联的图片描述 → LLM 知道有图可用 → 通过图片路径展示给用户。
 *
 * 纯启发式，无需 LLM vision 模型。
 *
 * 用法:
 *   node scripts/kb/enrich/pdf-image-extract.mjs                    # 批量处理全部 PDF
 *   node scripts/kb/enrich/pdf-image-extract.mjs <pdfPath>          # 单文件处理
 *   node scripts/kb/enrich/pdf-image-extract.mjs --check            # 预览不写入
 *   node scripts/kb/enrich/pdf-image-extract.mjs --rebuild          # 重新提取（覆盖已有）
 *
 * 依赖: Python + PyMuPDF + Pillow
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const RAW_DIR = join(ROOT, "data", "raw");
const RAW_TXT_DIR = join(ROOT, "data", "raw-txt");
const FIGURES_DIR = join(ROOT, "data", "kb", "figures");
const PY_SCRIPT = join(__dirname, "_pdf_extract_images.py");
const PYTHON = process.env.PYTHON_PATH || "python";

// 幂等标记
const DONE_MARKER = "\n【图片提取已完成】\n";

// ── helper ──

function findPdfFiles() {
  const files = readdirSync(RAW_DIR);
  return files
    .filter((f) => f.endsWith(".pdf") && !f.startsWith("_"))
    .sort();
}

function getTxtPath(pdfName) {
  return join(RAW_TXT_DIR, basename(pdfName, ".pdf") + ".txt");
}

function getEnrichedPath(pdfName) {
  return join(RAW_TXT_DIR, basename(pdfName, ".pdf") + ".enriched.txt");
}

/**
 * 获取指定页面的文本上下文。
 * 优先从 .enriched.txt 读取，回退到 .txt。
 */
function getPageContext(pdfName, targetPage) {
  // 页面在文本中的分隔特征：换页符、页码标记
  const candidates = [
    getEnrichedPath(pdfName),
    getTxtPath(pdfName),
  ];

  for (const path of candidates) {
    if (!existsSync(path)) continue;
    const text = readFileSync(path, "utf-8");

    // 尝试按换页符分页（pdftotext 通常用 \f 或多个换行分页）
    const pages = text.split(/\f/);
    if (pages.length >= targetPage) {
      const pageText = pages[targetPage - 1];
      if (pageText && pageText.trim().length > 20) {
        return pageText.trim().slice(0, 500); // 取前 500 字符作为上下文
      }
    }

    // 退一步：按双换行切分，取目标页附近的文本
    const blocks = text.split(/\n\n+/);
    const blockIdx = Math.min(Math.floor((blocks.length / Math.max(pages.length, 1)) * targetPage), blocks.length - 1);
    if (blockIdx >= 0 && blocks[blockIdx]) {
      return blocks[blockIdx].trim().slice(0, 500);
    }
  }

  return "";
}

/**
 * 为单张图片生成结构化描述文本。
 */
function buildImageCaption(image, pageContext) {
  const lines = [];

  // 图片元数据
  lines.push(`📷 图片位置: 第 ${image.page} 页`);
  lines.push(`📁 路径: ${image.filename}`);
  lines.push(`📐 尺寸: ${image.width}×${image.height}`);

  // 根据尺寸和位置推断图片类型
  const isWide = image.width > image.height * 1.5;
  const isTall = image.height > image.width * 1.5;
  const isSmall = image.width < 200 && image.height < 200;

  if (isWide && image.width > 500) {
    lines.push(`🖼️ 类型: 流程图/表格（宽幅横向图）`);
  } else if (isTall && image.height > 600) {
    lines.push(`🖼️ 类型: 完整页面截图/算法图（纵向长图）`);
  } else if (isSmall) {
    lines.push(`🖼️ 类型: 小图/图标`);
  } else {
    lines.push(`🖼️ 类型: 插图/图表`);
  }

  // 页面上下文摘要
  if (pageContext) {
    const cleanContext = pageContext
      .replace(/[\n\r]+/g, " ")
      .replace(/\s+/g, " ")
      .trim();
    lines.push(`📄 相邻文本: ${cleanContext.slice(0, 300)}`);
  }

  return lines.join("\n");
}

/**
 * 处理单个 PDF 文件的图片提取。
 */
function processPdf(pdfPath, opts = {}) {
  const { dryRun = false, rebuild = false } = opts;
  const pdfName = basename(pdfPath);
  const enrichedPath = getEnrichedPath(pdfName);

  // 幂等检查
  if (!rebuild && existsSync(enrichedPath)) {
    const existing = readFileSync(enrichedPath, "utf-8");
    if (existing.trimEnd().endsWith(DONE_MARKER.trim()) && existing.includes(DONE_MARKER.trim())) {
      return { file: pdfName, extracted: 0, skipped: true, reason: "已处理" };
    }
  }

  // 运行 Python 提取脚本
  const result = spawnSync(PYTHON, [PY_SCRIPT, pdfPath, FIGURES_DIR], {
    cwd: ROOT,
    encoding: "utf-8",
    timeout: 120000,
  });

  if (result.error) {
    return { file: pdfName, extracted: 0, error: `Python 执行失败: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return { file: pdfName, extracted: 0, error: `Python 退出码 ${result.status}: ${result.stderr?.slice(0, 300)}` };
  }

  let images;
  try {
    images = JSON.parse(result.stdout);
  } catch (e) {
    return { file: pdfName, extracted: 0, error: `JSON 解析失败: ${e.message}` };
  }

  if (images.error) {
    return { file: pdfName, extracted: 0, error: images.error };
  }

  // 无图片
  if (!images || images.length === 0) {
    return { file: pdfName, extracted: 0, skipped: true, reason: "无图片" };
  }

  // 构建描述文本
  const captions = [];
  for (const img of images) {
    const pageContext = getPageContext(pdfName, img.page);
    const caption = buildImageCaption(img, pageContext);
    captions.push(caption);
  }

  // 构建追加内容
  const imageSection = [
    "",
    "═══════════════════════════════════════",
    "【PDF 图片提取】（共 " + images.length + " 张）",
    "",
    ...captions.map((c, i) => `--- 图 ${i + 1} ---\n${c}\n`),
    "",
    DONE_MARKER.trim(),
  ].join("\n");

  if (dryRun) {
    return {
      file: pdfName,
      extracted: images.length,
      skipped: false,
      preview: captions.slice(0, 2),
      note: "(dry-run, 未写入)",
    };
  }

  // 写入 .enriched.txt（追加）
  mkdirSync(RAW_TXT_DIR, { recursive: true });
  const existingText = existsSync(enrichedPath)
    ? readFileSync(enrichedPath, "utf-8")
    : (existsSync(getTxtPath(pdfName))
      ? readFileSync(getTxtPath(pdfName), "utf-8")
      : "");

  // 如果已有其他 enrich 标记，插入在最后一个标记之前
  writeFileSync(enrichedPath, (existingText || "").trimEnd() + "\n" + imageSection, "utf-8");

  return {
    file: pdfName,
    extracted: images.length,
    skipped: false,
    note: "已写入",
  };
}

// ── 主入口 ──
function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--check");
  const rebuild = args.includes("--rebuild");

  const targetFile = args.find((a) => !a.startsWith("--") && a.endsWith(".pdf"));

  console.log(`\n═══ PDF 图片提取 ═══\n`);
  console.log(`图片输出目录: ${FIGURES_DIR}`);
  console.log(`模式: ${dryRun ? "预览(dry-run)" : rebuild ? "重新提取" : "增量"}\n`);

  mkdirSync(FIGURES_DIR, { recursive: true });

  if (targetFile) {
    const pdfPath = existsSync(targetFile) ? targetFile : join(RAW_DIR, targetFile);
    if (!existsSync(pdfPath)) {
      console.error(`❌ 文件不存在: ${pdfPath}`);
      process.exit(1);
    }
    const result = processPdf(pdfPath, { dryRun, rebuild });
    const icon = result.error ? "❌" : result.skipped ? "⏭️" : "✅";
    console.log(`  ${icon} ${result.file}: ${result.extracted || 0} 张图${result.error ? ` (${result.error})` : result.skipped ? ` (${result.reason})` : ""}`);
    if (result.preview) {
      console.log(`    预览:`);
      for (const p of result.preview) console.log(`    ${p.split("\n")[0]}`);
    }
  } else {
    const files = findPdfFiles();
    if (files.length === 0) {
      console.log("  data/raw/ 中未找到 PDF 文件。");
      process.exit(0);
    }

    console.log(`  找到 ${files.length} 个 PDF\n`);

    let totalExtracted = 0;
    let processed = 0;
    let skipped = 0;
    let errors = 0;

    for (const file of files) {
      const result = processPdf(join(RAW_DIR, file), { dryRun, rebuild });
      totalExtracted += result.extracted || 0;
      if (result.error) errors++;
      else if (result.skipped) skipped++;
      else processed++;

      const icon = result.error ? "❌" : result.skipped ? "⏭️" : "✅";
      const detail = result.error ? ` (${result.error.slice(0, 60)})` : result.skipped ? ` (${result.reason})` : "";
      console.log(`  ${icon} ${file}: ${result.extracted || 0} 张图${detail}`);
    }

    console.log(`\n─── 汇总 ───`);
    console.log(`处理: ${processed} 个文件`);
    console.log(`跳过: ${skipped} 个（已处理/无图片）`);
    console.log(`错误: ${errors} 个`);
    console.log(`图片: ${totalExtracted} 张 → ${FIGURES_DIR}`);
    console.log(dryRun ? "\n⚠️ dry-run 模式，未写入。加 --check 预览，不加则写入。" : "\n✅ 已全部写入。需重新执行 kb:rebuild 后索引生效。");
  }
}

main();
