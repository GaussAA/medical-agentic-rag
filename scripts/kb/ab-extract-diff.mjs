/**
 * A/B 抽取质量对照（对照「弃MD直用原始文档」决策）
 *
 * 同份原始文档，分别用：
 *   - Pi 原生抽取器：PDF→unpdf(pdf.js) / DOCX→mammoth（与 pi-knowledge engine.js 同款）
 *   - 本项目管线：   PDF→pdftotext -layout / DOCX→python-docx 桥
 * 比对中文保真度、章节标记留存率、全角数字占比，判断 Pi 原生抽取是否够格。
 *
 * 只读源目录、只写临时报告，绝不触碰 ~/.pi/knowledge/ 当前知识库。
 * 用法: node scripts/kb/ab-extract-diff.mjs
 */
import { createRequire } from "module";
import { pathToFileURL } from "url";
import { execFileSync } from "child_process";
import { readdirSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "fs";
import { join, extname, basename } from "path";
import os from "os";

// 兜底：单个文件异步抽取拒绝不应崩掉整轮
process.on("unhandledRejection", (e) => {
  console.error("  [unhandledRejection]", String(e && e.message ? e.message : e).slice(0, 120));
});
process.on("uncaughtException", (e) => {
  console.error("  [uncaughtException]", String(e && e.message ? e.message : e).slice(0, 120));
});

const SRC = "D:/JaNiy/Documents/medical-knowledge-docs/medical-knowlegde-origin";
const PK_NM = "C:/Users/JaNiy/.pi/agent/npm/node_modules";
const PY = "C:/Users/JaNiy/.workbuddy/binaries/python/envs/default/Scripts/python.exe";
const require = createRequire(join(PK_NM, "pi-knowledge/package.json"));

// unpdf 只 resolve/import 一次，避免在循环里反复加载
const unpdfExtractText = (async () => {
  const m = await import(pathToFileURL(require.resolve("unpdf")).href);
  return m.extractText;
})();
const mammoth = require("mammoth");

// ---------- 抽取器 ----------
async function piPdf(p) {
  const extractText = await unpdfExtractText;
  const buf = readFileSync(p);
  const { text } = await extractText(new Uint8Array(buf));
  const t = Array.isArray(text) ? text.join("\n\n") : text ?? "";
  return typeof t === "string" ? t : String(t);
}
async function piDocx(p) {
  const res = await mammoth.extractRawText({ path: p });
  return res.value || "";
}
function ourPdf(p) {
  // 必须与真实管线 ingest-batch.mjs 对齐：加 -enc UTF-8，否则中文 PDF 抽不出中文
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", p, "-"], {
    encoding: "utf-8",
    maxBuffer: 64 * 1024 * 1024,
  });
}
function ourDocx(p) {
  return execFileSync(PY, ["scripts/kb/_docx2txt.py", p]).toString("utf-8");
}

// ---------- 度量 ----------
const CJK = /[一-鿿]/g;
const HEADERS =
  /(^[一二三四五六七八九十百零]+[.．、])|（[一二三四五六七八九十]+）|^[０-９]+[.．、]|^[0-9]+[.、]/gm;
const FW_DIGIT = /[０-９]/g;
const ALL_DIGIT = /[0-9０-９]/g;

function metrics(t) {
  if (typeof t !== "string") return { len: 0, cjk: 0, heads: 0, fwRate: 0 };
  const cjk = (t.match(CJK) || []).length;
  const heads = (t.match(HEADERS) || []).length;
  const fw = (t.match(FW_DIGIT) || []).length;
  const all = (t.match(ALL_DIGIT) || []).length;
  return {
    len: t.length,
    cjk,
    heads,
    fwRate: all ? fw / all : 0,
  };
}

// ---------- 主流程 ----------
const files = readdirSync(SRC)
  .filter((f) => /\.(pdf|docx|doc)$/i.test(f))
  .filter((f) => !/\.nhc_tmp_/i.test(f)) // 排除卫健委官网残留临时文件
  .sort();
const rows = [];
let piFail = 0,
  ourFail = 0;

for (const f of files) {
  const p = join(SRC, f);
  const ext = extname(f).toLowerCase();
  let piT = null,
    ourT = null,
    piErr = null,
    ourErr = null;

  try {
    try {
      piT = ext === ".pdf" ? await piPdf(p) : await piDocx(p);
    } catch (e) {
      piErr = String(e.message || e).slice(0, 80);
      piFail++;
    }
    try {
      ourT = ext === ".pdf" ? ourPdf(p) : ourDocx(p);
    } catch (e) {
      ourErr = String(e.message || e).slice(0, 80);
      ourFail++;
    }

    const m = {
      file: f,
      ext,
      pi: piT != null ? metrics(piT) : null,
      our: ourT != null ? metrics(ourT) : null,
      piErr,
      ourErr,
    };
    // 相对差异（Pi 相对 我方）
    if (m.pi && m.our) {
      m.cjkRatio = m.our.cjk ? m.pi.cjk / m.our.cjk : null;
      m.headRatio = m.our.heads ? m.pi.heads / m.our.heads : null;
    }
    rows.push(m);
  } catch (fatal) {
    // 单文件整体兜底，绝不中断整轮
    rows.push({ file: f, ext, pi: null, our: null, piErr: "FATAL", ourErr: String(fatal.message || fatal).slice(0, 80) });
  }
  process.stdout.write(`  ${rows.length}/${files.length} ${f}\n`);
}

// ---------- 聚合 ----------
const pdfRows = rows.filter((r) => r.ext === ".pdf" && r.pi && r.our);
const docxRows = rows.filter((r) => r.ext === ".docx" && r.pi && r.our);
function agg(arr) {
  if (!arr.length) return null;
  const cjkRatios = arr.map((r) => r.cjkRatio).filter((x) => x != null);
  const headRatios = arr.map((r) => r.headRatio).filter((x) => x != null);
  const mean = (a) => a.reduce((s, x) => s + x, 0) / a.length;
  const piWorseCjk = arr.filter((r) => r.cjkRatio != null && r.cjkRatio < 0.85).length;
  const piWorseHead = arr.filter((r) => r.headRatio != null && r.headRatio < 0.7).length;
  return {
    n: arr.length,
    meanCjkRatio: +mean(cjkRatios).toFixed(3),
    meanHeadRatio: +mean(headRatios).toFixed(3),
    piWorseCjkCount: piWorseCjk,
    piWorseHeadCount: piWorseHead,
  };
}
const report = {
  ts: new Date().toISOString(),
  src: SRC,
  total: files.length,
  piFail,
  ourFail,
  pdf: agg(pdfRows),
  docx: agg(docxRows),
  rows: rows.map((r) => ({
    file: r.file,
    ext: r.ext,
    piCjk: r.pi?.cjk,
    ourCjk: r.our?.cjk,
    cjkRatio: r.cjkRatio,
    piHeads: r.pi?.heads,
    ourHeads: r.our?.heads,
    headRatio: r.headRatio,
    piErr: r.piErr,
    ourErr: r.ourErr,
  })),
};

const outPath = join(os.tmpdir(), "ab-extract-report.json");
writeFileSync(outPath, JSON.stringify(report, null, 2), "utf-8");

console.log("\n===== A/B 抽取质量对照 =====");
console.log(`源目录: ${SRC}`);
console.log(`文件总数: ${files.length} (PDF ${pdfRows.length} 可比 / DOCX ${docxRows.length} 可比)`);
console.log(`Pi 抽取失败: ${piFail} | 我方失败: ${ourFail}`);
if (report.pdf)
  console.log(
    `PDF 均值: 中文比=${report.pdf.meanCjkRatio} 章节比=${report.pdf.meanHeadRatio} | Pi 明显偏弱(中文本<85%): ${report.pdf.piWorseCjkCount}份, 章节丢>30%: ${report.pdf.piWorseHeadCount}份`
  );
if (report.docx)
  console.log(
    `DOCX 均值: 中文比=${report.docx.meanCjkRatio} 章节比=${report.docx.meanHeadRatio} | Pi 明显偏弱(中文本<85%): ${report.docx.piWorseCjkCount}份, 章节丢>30%: ${report.docx.piWorseHeadCount}份`
  );
console.log(`报告: ${outPath}`);
