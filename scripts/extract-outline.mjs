/**
 * 医疗指南结构化解析脚本
 * 提取每份指南的章节标题、层级、关键内容，生成结构化 JSON 大纲
 *
 * 用法: node scripts/extract-outline.mjs
 * 输出: medical-knowlegde-base/.outline.json
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const KB_DIR = join(__dirname, "..", "medical-knowlegde-base");
const OUT_FILE = join(__dirname, "..", "medical-knowlegde-base", ".outline.json");

// 中医数字章节匹配: 一、 二、... / （一） （二）... / 1. 2....
const SECTION_RE = /^(#{2,4})\s+(.+)$/gm;
// 关键内容段落模式：含"推荐"、"诊断"、"治疗"的段落
const KEY_PARA_RE = /^[^#\n]{30,}?(推荐|诊断|治疗|筛查|预后|分期|药物|剂量)[^#\n]{30,}。$/gm;

async function parseFile(filePath) {
  const text = await readFile(filePath, "utf-8");
  const fileName = filePath.split(/[/\\]/).pop().replace(/\.md$/i, "");

  // Extract title from first h1
  const titleMatch = text.match(/^#\s+(.+)$/m);

  // Extract section structure
  const sections = [];
  let match;
  while ((match = SECTION_RE.exec(text)) !== null) {
    const level = match[1].length; // 2, 3, or 4
    const title = match[2].trim();
    const startPos = match.index;
    sections.push({ level, title, startPos });
  }

  // Build hierarchy
  const hierarchy = [];
  const stack = [{ level: 1, title: titleMatch?.[1] || fileName, children: [] }];

  for (const sec of sections) {
    const node = { level: sec.level, title: sec.title, children: [] };
    while (stack.length > 0 && stack[stack.length - 1].level >= sec.level) {
      stack.pop();
    }
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else {
      hierarchy.push(node);
    }
    stack.push(node);
  }

  // Extract key paragraphs (detect treatment/diagnosis/screening content)
  const keyParagraphs = [];
  const paraRe = new RegExp(KEY_PARA_RE.source, "gm");
  while ((match = paraRe.exec(text)) !== null) {
    const para = match[0].trim();
    if (para.length > 30 && para.length < 500) {
      keyParagraphs.push(para.slice(0, 200));
    }
  }

  return {
    id: fileName,
    title: titleMatch?.[1]?.trim() || fileName,
    sectionCount: sections.length,
    keyParagraphCount: keyParagraphs.length,
    hierarchy,
    keyParagraphs: keyParagraphs.slice(0, 10), // keep top 10
  };
}

async function main() {
  const files = (await readdir(KB_DIR))
    .filter((f) => f.endsWith(".md") && !f.startsWith("."))
    .sort();

  console.log(`发现 ${files.length} 份指南文件\n`);

  const results = [];
  for (const file of files) {
    const filePath = join(KB_DIR, file);
    const result = await parseFile(filePath);
    results.push(result);
    console.log(`  [${String(results.length).padStart(2)}] ${result.title}`);
    console.log(`       章节: ${result.sectionCount}, 关键段落: ${result.keyParagraphCount}`);
  }

  const outline = {
    generatedAt: new Date().toISOString(),
    totalFiles: results.length,
    totalSections: results.reduce((s, r) => s + r.sectionCount, 0),
    totalKeyParagraphs: results.reduce((s, r) => s + r.keyParagraphCount, 0),
    guides: results,
  };

  await writeFile(OUT_FILE, JSON.stringify(outline, null, 2), "utf-8");
  console.log(`\n大纲已写入: ${OUT_FILE}`);
  console.log(`总计: ${outline.totalFiles} 份指南, ${outline.totalSections} 个章节, ${outline.totalKeyParagraphs} 条关键段落`);
}

main().catch(console.error);
