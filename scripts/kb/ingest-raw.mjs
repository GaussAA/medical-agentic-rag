// scripts/kb/ingest-raw.mjs
// 知识库偏科缓解 · 官方文件直供管线（B 方案，最合规）
//
// 用途：大帅在已登录浏览器下载卫健委/权威机构指南（PDF/HTML/MD），
//       丢入本管线指定的投放目录后，由本脚本规范化入库，杜绝网络抓取与杜撰。
//
// 流程：
//   1. 读投放的原始文件（PDF→pdftotext 转文本；HTML→去标签留结构；MD→直用）
//   2. 规范化为带元数据的 Markdown（标题/来源/抓取日期/正文）
//   3. 写入 knowledge-base/<指南名>.md —— 注意：此为中间产物，
//      2026-07-12 数据治理后该目录已清理 .md 文件（仅保留派生索引 JSON），
//      ingest 仍写 MD 是为了保持管线向后兼容，后续可考虑去掉此步直接走 TXT 路径
//   4. 追加登记到 kb-sources.json（type=local + department 自动归类）
//   5. 触发既有 extract-outline.mjs 刷新大纲（确定性，无需 Key）
//
// 红线：绝不生成占位正文；PDF/HTML 解析失败即报错退出，不落半截文件。
//
// 用法：node scripts/kb/ingest-raw.mjs <投放文件> [--name 指南名] [--dept 专科] [--src 来源URL]

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname, extname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB_DIR = join(ROOT, "data", "kb");
const REG_FILE = join(ROOT, "data/kb/kb-sources.json");
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const kb = await import(MOD);

// ---------- 参数解析 ----------
const argv = process.argv.slice(2);
const positional = argv.filter((a) => !a.startsWith("--"));
const getOpt = (k) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const rawPath = positional[0];
if (!rawPath) {
  console.error("用法: node scripts/kb/ingest-raw.mjs <投放文件> [--name 指南名] [--dept 专科] [--src 来源URL]");
  process.exit(1);
}
if (!existsSync(rawPath)) {
  console.error(`✗ 投放文件不存在: ${rawPath}`);
  process.exit(1);
}

const ext = extname(rawPath).toLowerCase();
const defaultName = basename(rawPath).replace(/\.(pdf|html?|md)$/i, "");
const name = (getOpt("name") || defaultName).replace(/\s+/g, "");
const src = getOpt("src") || "大帅官方文件直供";

// ---------- 1. 解析原始文件为纯文本 ----------
function extractText(path, ext) {
  if (ext === ".md") {
    return readFileSync(path, "utf-8");
  }
  if (ext === ".pdf") {
    try {
      return execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", path, "-"], {
        encoding: "utf-8",
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch (e) {
      throw new Error(`pdftotext 失败（确认已安装 poppler）: ${e.message}`);
    }
  }
  if (ext === ".html" || ext === ".htm") {
    const html = readFileSync(path, "utf-8");
    // 去 script/style，保留段落与标题结构
    const cleaned = html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<(br|p|div|li|h[1-6])[^>]*>/gi, "\n")
      .replace(/<\/?(?![\s])\/?[a-zA-Z][^>]*>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    return cleaned;
  }
  throw new Error(`不支持的扩展名: ${ext}（仅 PDF/HTML/MD）`);
}

// ---------- 2. 规范化为 Markdown ----------
function normalizeToMarkdown(text, name, src) {
  const date = new Date().toISOString().slice(0, 10);
  // 取首行非空作标题候选；否则用名称
  const firstLine = (text.split("\n").find((l) => l.trim().length > 4) || name).trim();
  const title = name.includes("指南") || name.includes("规范") ? name : name;
  const body = text
    .replace(/^\s*#{1,6}\s+.*$/gm, "") // 移除原文件可能自带的标题
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  return `# ${title}\n\n> 来源: ${src}\n> 入库方式: 官方文件直供（大帅提供）\n> 抓取/入库日期: ${date}\n\n${body}\n`;
}

// ---------- 3~4. 写库 + 登记 ----------
function registerSource(name, mdRelPath, department, content) {
  const reg = kb.loadRegistry(REG_FILE);
  const id = name;
  if (reg.sources.some((s) => s.id === id)) {
    console.log(`  · 来源 ${id} 已登记，跳过重复登记`);
  } else {
    reg.sources.push({
      id,
      name,
      type: "local",
      localPath: mdRelPath,
      cadenceDays: 30,
      validate: "sha256",
      department,
      lastChecked: new Date().toISOString(),
      lastHash: kb.contentHash(content || ""), // P0-3 修复：算真实内容哈希，灭空串占位（变更检测方可生效）
      note: "官方文件直供，待抽检权威度",
    });
    kb.saveRegistry(reg, REG_FILE);
    console.log(`  ✓ 已登记来源: ${id} (department=${department})`);
  }
}

// ---------- 主流程 ----------
try {
  mkdirSync(KB_DIR, { recursive: true });
  console.log(`[ingest] 解析投放文件: ${rawPath} (${ext})`);
  const text = extractText(rawPath, ext);
  if (!text || text.trim().length < 50) {
    throw new Error("解析后正文为空或过短，疑似非指南内容，已拒绝落库（防杜撰）");
  }
  const md = normalizeToMarkdown(text, name, src);
  const mdPath = join(KB_DIR, `${name}.md`);
  const mdRel = join("data", "kb", `${name}.md`); // P0-3 修复：跨平台 join，灭 Windows 专属反斜杠
  if (existsSync(mdPath)) {
    console.error(`✗ 目标已存在: ${mdPath}（避免覆盖既有指南，请换名或先删）`);
    process.exit(1);
  }
  writeFileSync(mdPath, md, "utf-8");
  console.log(`[ingest] 已写入规范化 MD: ${mdPath} (${md.length} 字节)`);

  const dept = getOpt("dept") || kb.inferDepartment(name);
  registerSource(name, mdRel, dept);

  // 5. 触发大纲刷新（确定性，无需 Key）
  console.log("[ingest] 刷新大纲 (.outline.json)…");
  execFileSync(
    process.execPath,
    [join(ROOT, "scripts/kb/extract-outline.mjs")],
    { stdio: "inherit", cwd: ROOT },
  );

  console.log("\n✓ 入库完成。建议人工抽检标题/机构/年份与官方一致；随后可跑:");
  console.log("    node scripts/kb/kb-update.mjs coverage   # 验偏科指数下降");
} catch (err) {
  console.error(`\n✗ 摄取中止（未落半截文件）: ${err.message}`);
  process.exit(1);
}
