/**
 * 准备原始知识库（方案 B：保大脑）
 *
 * 1. 把原始目录（D:/JaNiy/.../medical-knowlegde-origin）下可抽取的 PDF/DOCX
 *    复制进项目内 medical-raw/（排除 .doc 老格式与 .nhc_tmp_ 残留）。
 * 2. 对每份生成归一化纯文本 medical-raw-txt/<同名>.txt，
 *    抽取方式与 ingest-batch 同款（pdftotext -enc UTF-8 / python-docx 桥），
 *    保证中文保真，供 extract-outline 复用中文层级正则。
 *
 * 只读源目录、只写项目内 medical-raw/ 与 medical-raw-txt/。
 * 用法: node scripts/kb/prepare-raw.mjs
 */
import { createRequire } from "module";
import { execFileSync } from "child_process";
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync,
} from "node:fs";
import { join, extname, basename } from "node:path";

const SRC = process.env.MEDICAL_RAW_SRC || "D:/JaNiy/Documents/medical-knowledge-docs/medical-knowlegde-origin";
const ROOT = process.cwd();
const RAW_DIR = join(ROOT, "medical-raw");
const TXT_DIR = join(ROOT, "medical-raw-txt");
const PY =
  process.env.PY_VENV ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe");
const DOCX_BRIDGE = join(ROOT, "scripts", "kb", "_docx2txt.py");

mkdirSync(RAW_DIR, { recursive: true });
mkdirSync(TXT_DIR, { recursive: true });

function extractPdf(p) {
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", p, "-"], {
    encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
}
function extractDocx(p) {
  return execFileSync(PY, [DOCX_BRIDGE, p], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}
function extractDoc(p) {
  // antiword 是 Windows 原生程序，必须传 Windows 盘符路径（不认 Git Bash 的 /d/ 挂载路径）。
  // 默认映射即可正确抽出中文（代码页 1200/UTF-16 的 OLE2 .doc）。
  return execFileSync("antiword", [p], {
    encoding: "utf-8", maxBuffer: 64 * 1024 * 1024,
  });
}

const files = readdirSync(SRC)
  .filter((f) => /\.(pdf|docx|doc)$/i.test(f) && !/\.nhc_tmp_/i.test(f) && statSync(join(SRC, f)).isFile())
  .sort();

console.log(`待准备文件: ${files.length} (含 .doc 经 antiword 抽取；排除 .nhc_tmp_)`);
let ok = 0, skip = 0;
for (const f of files) {
  const ext = extname(f).toLowerCase();
  const base = f.slice(0, -ext.length);
  const srcP = join(SRC, f);
  const txtP = join(TXT_DIR, base + ".txt");

  let txt;
  try {
    if (ext === ".pdf") {
      copyFileSync(srcP, join(RAW_DIR, f)); // 二进制真源（Pi 原生 PDF 摄取）
      txt = extractPdf(srcP);
    } else if (ext === ".docx") {
      copyFileSync(srcP, join(RAW_DIR, f)); // 二进制真源（Pi 原生 DOCX 摄取）
      txt = extractDocx(srcP);
    } else if (ext === ".doc") {
      // 老格式 .doc：mammoth/Pi 均无法摄取。经 antiword 抽文本，
      // 落为 medical-raw/<base>.txt（Pi 原生 TXT 摄取），不复制二进制 .doc 以免 ingest 失败。
      txt = extractDoc(srcP);
      writeFileSync(join(RAW_DIR, base + ".txt"), txt, "utf-8");
    }
  } catch (e) {
    console.error(`  [抽取失败] ${f}: ${String(e.message || e).slice(0, 80)}`);
    skip++;
    continue;
  }
  writeFileSync(txtP, txt, "utf-8"); // 归一化层（所有类型统一）
  ok++;
  process.stdout.write(`  ${ok}/${files.length} ${f} (${txt.length} 字符)\n`);
}

console.log(`\n完成: 成功 ${ok} 份, 抽取失败 ${skip} 份`);
console.log(`原始文档目录: ${RAW_DIR}`);
console.log(`归一化文本目录: ${TXT_DIR}`);
