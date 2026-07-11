// scripts/ops/watchdog-new-files.mjs
// 知识库新文件看门狗：扫描投放目录，自动检测新指南文件并入库。
//
// 流程：
//   1. 扫描 medical-raw/ 目录，找出所有 .pdf/.docx/.doc 文件
//   2. 与 kb-sources.json 已登记来源比对（按文件名 baseline 匹配）
//   3. 未登记的新文件自动走 ingest-raw.mjs 管线入库
//   4. 检测到新版本替换时自动标记旧版已废止
//
// 用法：
//   node scripts/ops/watchdog-new-files.mjs [--dry-run] [--dir <投放目录>]
//
// --dry-run: 仅列出新文件，不实际入库
// --dir:    扫描指定目录（默认 medical-raw/）
//
// 纯 node 运行，无外部依赖。PDF 抽取依赖 poppler-utils (pdftotext)。

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB_DIR = join(ROOT, "medical-knowlegde-base");
const REG_FILE = join(ROOT, "kb-sources.json");
const dryRun = process.argv.includes("--dry-run");

// 取投放目录
const dirIdx = process.argv.indexOf("--dir");
const WATCH_DIR = dirIdx >= 0 ? process.argv[dirIdx + 1] : join(ROOT, "medical-raw");

// 加载 kb-sources
async function loadRegistry() {
  const modPath = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
  const kb = await import(modPath);
  return { kb, reg: kb.loadRegistry(REG_FILE) };
}

// 提取文件名基准（去版本后缀、去扩展名）
function fileBaseline(filename) {
  const noExt = basename(filename).replace(/\.\w+$/, "");
  // 去版次：如 (2024年版) / (2024版) / (2024年修订版)
  const stripped = noExt.replace(/[（(]\d{4}\s*年?(?:版|修订版|修订本|本)[）)]$/, "").trim();
  return stripped;
}

async function main() {
  console.log(`[watchdog] 扫描目录: ${WATCH_DIR}`);
  if (dryRun) console.log("  演练模式 --dry-run（不实际入库）");

  if (!existsSync(WATCH_DIR)) {
    console.error(`✗ 目录不存在: ${WATCH_DIR}`);
    process.exit(1);
  }

  // 1. 扫描投放目录
  const allFiles = readdirSync(WATCH_DIR, { withFileTypes: true })
    .filter((d) => d.isFile())
    .map((d) => ({
      name: d.name,
      path: join(WATCH_DIR, d.name),
      ext: extname(d.name).toLowerCase(),
    }))
    .filter((f) => [".pdf", ".docx", ".doc"].includes(f.ext));
  console.log(`  找到 ${allFiles.length} 个可摄取文件`);

  // 2. 加载已登记来源
  const { kb, reg } = await loadRegistry();
  const existing = new Set(reg.sources.map((s) => s.id));

  // 对比：按文件名称的基准名匹配
  const newFiles = [];
  const updateFiles = [];
  for (const f of allFiles) {
    const baseline = fileBaseline(f.name);
    if (existing.has(baseline) || existing.has(f.name.replace(/\.\w+$/, ""))) {
      continue; // 已登记
    }
    // 检查是否是某现有指南的新版本
    const isUpdate = [...existing].some((eid) => {
      const eBase = fileBaseline(eid);
      // 基线相同但文件不同
      return eBase === baseline && eid !== f.name.replace(/\.\w+$/, "");
    });
    if (isUpdate) updateFiles.push(f);
    else newFiles.push(f);
  }

  console.log(`  新增指南: ${newFiles.length}`);
  for (const f of newFiles) console.log(`    + ${f.name}`);
  console.log(`  版本更新: ${updateFiles.length}`);
  for (const f of updateFiles) console.log(`    ~ ${f.name}`);

  if (dryRun) {
    console.log("\n  演练模式完成。执行 node scripts/ops/watchdog-new-files.mjs 以实际入库。");
    process.exit(0);
  }

  if (newFiles.length === 0 && updateFiles.length === 0) {
    console.log("\n  无新文件需要处理 ✓");
    process.exit(0);
  }

  // 3. 新文件入库
  console.log("\n  开始入库...");
  for (const f of newFiles) {
    console.log(`  [ingest] ${f.name}...`);
    try {
      execFileSync(
        process.execPath,
        [
          join(ROOT, "scripts/kb/ingest-raw.mjs"),
          f.path,
          "--name", basename(f.name).replace(/\.\w+$/, ""),
        ],
        { stdio: "inherit", cwd: ROOT },
      );
      console.log(`  ✓ ${f.name}`);
    } catch (e) {
      console.error(`  ✗ ${f.name} 入库失败: ${e.message}`);
    }
  }

  // 4. 版本更新 -> 旧版标记废止
  if (updateFiles.length > 0) {
    console.log("\n  版本更新检测，重建索引标记废止...");
    try {
      execFileSync(
        process.execPath,
        [join(ROOT, "scripts/kb/build-guide-index.mjs")],
        { stdio: "inherit", cwd: ROOT },
      );
      console.log("  ✓ 索引已重建（废止标记已自动计算）");
    } catch (e) {
      console.error(`  ✗ 索引重建失败: ${e.message}`);
    }
  }

  console.log(`\n✓ watchog 完成。新增 ${newFiles.length} 份、更新 ${updateFiles.length} 份。`);
}

main().catch((err) => {
  console.error("[watchdog] 失败:", err.message);
  process.exit(1);
});
