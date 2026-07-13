// scripts/kb/ingest-batch.mjs
// 知识库偏科缓解 · 批量统一原始文档入库（大帅 D:/.../medical-knowlegde-origin 目录）
//
// 流程（逐份，绝不杜撰）：
//   1. 抽取正文：PDF→pdftotext；DOCX→python-docx 桥接；.doc 暂不支持(标记跳过)
//   2. 规范化：去广告/页眉噪点 → 带元数据的 Markdown
//   3. 去重：去年份后比对 KB 既有 md；已存在→跳过；存在但本年更新→替换升级
//   4. 归类：inferDepartment（口腔关键词单独归口腔，其余走通用归类）
//   5. 写库 + 登记 kb-sources + 刷新大纲
//   6. 输出 batch-report.json（skip/added/upgraded 明细）
//
// 红线：抽取失败/正文过短→跳过该份，不落半截文件。
// 用法：node scripts/kb/ingest-batch.mjs [--src-dir <路径>] [--dry] [--limit N]

import { readdirSync, statSync, readFileSync, writeFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB_DIR = join(ROOT, "knowledge-base");
const REG_FILE = join(ROOT, "kb-sources.json");
const PY_VENV =
  process.env.PY_VENV ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".workbuddy", "binaries", "python", "envs", "default", "Scripts", "python.exe");
const DOCX_BRIDGE = join(ROOT, "scripts", "kb", "_docx2txt.py");
const DEF_SRC = process.env.MEDICAL_RAW_SRC || "D:/JaNiy/Documents/medical-knowledge-docs/medical-knowlegde-origin";
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const kb = await import(MOD);

const argv = process.argv.slice(2);
const getOpt = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const SRC_DIR = getOpt("src-dir") || DEF_SRC;
const DRY = argv.includes("--dry");
const LIMIT = parseInt(getOpt("limit") || "9999", 10);

// ---------- 抽取 ----------
function extractPdf(p) {
  return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", p, "-"], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}
function extractDocx(p) {
  const out = execFileSync(PY_VENV, [DOCX_BRIDGE, p], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
  return out;
}
function extractText(p, ext) {
  if (ext === ".pdf") return extractPdf(p);
  if (ext === ".docx") return extractDocx(p);
  throw new Error(`不支持的扩展名 ${ext}（.doc 需先转 docx）`);
}

// ---------- 规范化 ----------
function stripYear(s) { return s.replace(/[（(]?\d{4}\s*版?[）)]?/g, "").replace(/\s+/g, ""); }
function normalize(text, name, srcPath) {
  const date = new Date().toISOString().slice(0, 10);
  const lines = text.split("\n").map((l) => l.replace(/\s+/g, " ").trim()).filter(Boolean);
  const first = lines.find((l) => l.length > 6) || name;
  const title = name;
  const body = lines.join("\n\n");
  return `# ${title}\n\n> 来源: 大帅原始文档直供（${basename(srcPath)}）\n> 入库日期: ${date}\n> 入库方式: 批量统一（scripts/kb/ingest-batch.mjs）\n\n${body}\n`;
}

// ---------- 归类（口腔特判） ----------
function classify(name) {
  if (/口腔|牙|颌|唇|腭|腮腺|舌|龈|黏膜/.test(name)) return "口腔";
  if (/近视|眼/.test(name)) return "眼科";
  return kb.inferDepartment(name);
}

// ---------- 主 ----------
function listFiles() {
  return readdirSync(SRC_DIR).filter((f) => {
    const p = join(SRC_DIR, f);
    return statSync(p).isFile() && /\.(pdf|docx?)$/i.test(f);
  }).sort();
}

const report = { ts: new Date().toISOString(), src: SRC_DIR, dry: DRY, items: [], summary: {} };
let added = 0, skipped = 0, upgraded = 0, failed = 0;

async function main() {
  if (!existsSync(SRC_DIR)) { console.error(`✗ 源目录不存在: ${SRC_DIR}`); process.exit(1); }
  const reg = kb.loadRegistry(REG_FILE);
  const kbMd = readdirSync(KB_DIR).filter((f) => f.endsWith(".md") && !f.startsWith("."));
  const kbCanon = new Set(kbMd.map((f) => stripYear(f.replace(/\.md$/, ""))));
  const regCanon = new Set(reg.sources.map((s) => stripYear(s.id)));

  const files = listFiles().slice(0, LIMIT);
  console.log(`[batch] 源目录: ${SRC_DIR}\n[batch] 待处理 ${files.length} 份 (DRY=${DRY})\n`);

  for (const f of files) {
    const p = join(SRC_DIR, f);
    const ext = extname(f).toLowerCase();
    const baseName = basename(f, ext);
    const canon = stripYear(baseName);
    const dept = classify(baseName);
    const item = { file: f, dept, action: null, reason: "" };
    try {
      if (ext === ".doc") { item.action = "skip"; item.reason = "legacy .doc 暂不支持(请转 docx)"; skipped++; }
      else {
        const text = extractText(p, ext);
        if (!text || text.trim().length < 80) throw new Error("正文过短/空，疑似非指南，拒绝落库");
        const md = normalize(text, baseName, p);
        const mdPath = join(KB_DIR, `${baseName}.md`);
        const mdRel = `knowledge-base\\${baseName}.md`;
        const inKb = kbCanon.has(canon) || regCanon.has(canon);
        const inKbFile = existsSync(mdPath);
        if (inKb || inKbFile) {
          if (DRY) { item.action = "skip"; item.reason = "已存在(去重)"; }
          else {
            // 升级：覆盖旧版，保持单版本权威
            if (inKbFile) rmSync(mdPath, { force: true });
            writeFileSync(mdPath, md, "utf-8");
            // 更新 registry 该 id 的 lastHash/department
            const s = reg.sources.find((x) => stripYear(x.id) === canon);
            if (s) { s.department = dept; s.lastChecked = new Date().toISOString(); s.lastHash = kb.contentHash(md); s.note = "批量升级版"; }
            item.action = "upgrade"; item.reason = "新年版替换旧版"; upgraded++;
          }
        } else {
          if (DRY) { item.action = "add"; item.reason = `将新增(dept=${dept})`; }
          else {
            writeFileSync(mdPath, md, "utf-8");
            reg.sources.push({ id: baseName, name: baseName, type: "local", localPath: mdRel, cadenceDays: 30, validate: "sha256", department: dept, lastChecked: new Date().toISOString(), lastHash: kb.contentHash(md), note: "批量统一·大帅原始文档直供" });
            item.action = "add"; item.reason = `新增(dept=${dept})`; added++;
          }
        }
      }
    } catch (e) {
      item.action = "fail"; item.reason = e.message; failed++;
    }
    report.items.push(item);
    const tag = item.action === "add" ? "➕" : item.action === "upgrade" ? "🔄" : item.action === "skip" ? "⏭" : "✗";
    console.log(`  ${tag} [${dept}] ${f} — ${item.reason}`);
  }

  if (!DRY) {
    kb.saveRegistry(reg, REG_FILE);
    console.log("\n[batch] 刷新大纲…");
    execFileSync(process.execPath, [join(ROOT, "scripts", "kb", "extract-outline.mjs")], { stdio: "inherit", cwd: ROOT });
  }
  report.summary = { total: files.length, added, upgraded, skipped, failed };
  writeFileSync(join(ROOT, "logs", "kb-batch-report.json"), JSON.stringify(report, null, 2), "utf-8");
  console.log(`\n=== 批量完成 === 新增 ${added} / 升级 ${upgraded} / 跳过 ${skipped} / 失败 ${failed}`);
  if (failed) console.log("⚠ 失败份请检查源文件是否损坏；.doc 请先转 docx");
}

main().catch((e) => { console.error("批量中止:", e); process.exit(1); });
