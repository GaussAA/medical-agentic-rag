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
 * 用法: node scripts/prepare-raw.mjs
 */
import { createRequire } from "module";
import { execFileSync } from "child_process";
import {
  readdirSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, rmSync, statSync,
} from "node:fs";
import { join, extname, basename } from "node:path";

const SRC = "D:/JaNiy/Documents/medical-knowledge-docs/medical-knowlegde-origin";
const ROOT = process.cwd();
const RAW_DIR = join(ROOT, "medical-raw");
const TXT_DIR = join(ROOT, "medical-raw-txt");
const PY = "C:/Users/JaNiy/.workbuddy/binaries/python/envs/default/Scripts/python.exe";
const DOCX_BRIDGE = join(ROOT, "scripts", "_docx2txt.py");

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

const files = readdirSync(SRC)
  .filter((f) => /\.(pdf|docx)$/i.test(f) && !/\.nhc_tmp_/i.test(f) && statSync(join(SRC, f)).isFile())
  .sort();

console.log(`待准备文件: ${files.length} (已排除 .doc 与 .nhc_tmp_)`);
let ok = 0, skip = 0;
for (const f of files) {
  const ext = extname(f).toLowerCase();
  const base = f.slice(0, -ext.length);
  const srcP = join(SRC, f);
  const rawP = join(RAW_DIR, f);
  const txtP = join(TXT_DIR, base + ".txt");

  // 1) 复制原始文件进项目
  copyFileSync(srcP, rawP);

  // 2) 生成归一化文本
  let txt;
  try {
    txt = ext === ".pdf" ? extractPdf(srcP) : extractDocx(srcP);
  } catch (e) {
    console.error(`  [抽取失败] ${f}: ${String(e.message || e).slice(0, 80)}`);
    skip++;
    continue;
  }
  writeFileSync(txtP, txt, "utf-8");
  ok++;
  process.stdout.write(`  ${ok}/${files.length} ${f} (${txt.length} 字符)\n`);
}

console.log(`\n完成: 成功 ${ok} 份, 抽取失败 ${skip} 份`);
console.log(`原始文档目录: ${RAW_DIR}`);
console.log(`归一化文本目录: ${TXT_DIR}`);
