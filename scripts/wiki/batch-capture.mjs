#!/usr/bin/env node
/**
 * wiki-batch-capture — 批量将本地 txt 文件捕获为 wiki 源包
 *
 * 扫描 data/raw-txt/ 中的核心指南文件，为每个文件创建标准源包结构，
 * 然后调用 pi 执行 wiki_ingest 批量处理。
 *
 * 用法:
 *   node scripts/wiki/batch-capture.mjs                   # 捕获+提示ingest
 *   node scripts/wiki/batch-capture.mjs --list            # 仅列出待捕获文件
 *   node scripts/wiki/batch-capture.mjs --dry-run         # 预览不执行
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const PROJECT_ROOT = process.cwd();
const RAW_TXT_DIR = join(PROJECT_ROOT, "data", "raw-txt");
const WIKI_RAW_SOURCES = join(PROJECT_ROOT, ".llm-wiki", "raw", "sources");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const onlyList = args.includes("--list");

// ── 核心指南文件筛选关键词 ──
const CORE_GUIDE_PATTERNS = [
  // ── 原有慢病肿瘤核心 ──
  "高血压", "糖尿病", "肺炎", "肝癌", "肺癌", "乳腺癌", "胃癌",
  "幽门螺杆菌", "结核", "慢阻肺", "脑卒中", "前列腺癌",
  "宫颈癌", "淋巴瘤", "白血病", "甲状腺癌", "甲状腺结节",
  "骨质疏松", "乙肝", "胰腺炎",
  "过敏", "产后出血", "妊娠", "多重用药", "合理用药",
  "老年", "髋部骨折", "脑胶质瘤",
  // ── 新增心血管 ──
  "脑血管", "冠脉", "冠心病", "心力衰竭", "心衰",
  "心房颤动", "心律失常", "心脏瓣膜", "动脉粥样硬化",
  // ── 新增肿瘤 ──
  "胰腺癌", "食管癌", "卵巢癌", "子宫内膜", "膀胱癌",
  "黑色素瘤", "肾癌", "新型抗肿瘤",
  // ── 新增感染/呼吸 ──
  "艾滋病", "流行性感冒", "流感", "慢性阻塞性肺疾病",
  "新型冠状病毒", "新冠", "分枝杆菌", "侵袭性真菌",
  // ── 新增消化 ──
  "克罗恩", "溃疡性结肠炎", "乙型肝炎", "肝硬化",
  // ── 新增神经/血液 ──
  "癫痫", "帕金森", "阿尔茨海默", "多发性硬化",
  "视神经脊髓炎", "易栓症", "血友病", "自身免疫性溶血",
  "骨髓增生异常", "贫血",
  // ── 新增代谢/肾 ──
  "肥胖", "慢性肾脏病", "肾病",
  // ── 新增外科/骨科/康复路径 ──
  "骨折", "关节置换", "加速康复", "经皮椎体", "腰椎", "颈椎",
  // ── 新增口腔/颌面 ──
  "口腔", "唇裂", "腭裂", "颌骨", "牙",
  // ── 新增妇产/儿科/其他 ──
  "胎盘植入", "儿童", "儿科",
  "ECMO", "体外膜肺", "安宁疗护",
  "罕见病", "新型冠状病毒", "胰腺",
];

function findCoreGuides() {
  const allFiles = readdirSync(RAW_TXT_DIR).filter((f) => f.endsWith(".txt") || f.endsWith(".md"));
  return allFiles
    .filter((f) => CORE_GUIDE_PATTERNS.some((p) => f.includes(p)))
    .sort();
}

function pad(num, width) {
  return String(num).padStart(width, "0");
}

function fmtDate() {
  return new Date().toISOString().split("T")[0];
}

function makeSourceId(index) {
  const today = fmtDate();
  return `SRC-${today}-${pad(index, 3)}`;
}

function createSourcePacket(fileName, sourceId) {
  const srcPath = join(RAW_TXT_DIR, fileName);
  if (!existsSync(srcPath)) {
    return null;
  }

  const packetDir = join(WIKI_RAW_SOURCES, sourceId);
  const title = fileName.replace(/\.txt$/i, "");

  if (existsSync(packetDir)) {
    return null; // 已存在，跳过
  }

  // 读取文件内容
  let content;
  try {
    content = readFileSync(srcPath, "utf-8");
  } catch {
    return null;
  }

  if (!content || content.trim().length < 50) {
    return null; // 空文件或太短，跳过
  }

  // 创建目录结构
  if (!dryRun) {
    mkdirSync(join(packetDir, "original"), { recursive: true });
  }

  // manifest.json
  const manifest = {
    id: sourceId,
    captured: fmtDate(),
    packet_version: "1.0",
    title,
    format: "text",
    source: fileName,
    extractor: "passthrough",
    extraction_status: "success",
  };

  if (!dryRun) {
    writeFileSync(join(packetDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf-8");
    writeFileSync(join(packetDir, "extracted.md"), content, "utf-8");
  }

  return {
    sourceId,
    title: title.slice(0, 60),
    chars: content.length,
  };
}

// ── 获取现有源包的最大序号 ──
function getMaxSeq() {
  if (!existsSync(WIKI_RAW_SOURCES)) return 0;
  const dirs = readdirSync(WIKI_RAW_SOURCES).filter((d) => d.startsWith("SRC-"));
  let max = 0;
  for (const d of dirs) {
    const parts = d.split("-");
    const seq = parseInt(parts[parts.length - 1], 10);
    if (!isNaN(seq) && seq > max) max = seq;
  }
  return max;
}

// ── 获取已捕获文件名集合（去重依据）──
function getCapturedFilenames() {
  if (!existsSync(WIKI_RAW_SOURCES)) return new Set();
  const dirs = readdirSync(WIKI_RAW_SOURCES).filter((d) => d.startsWith("SRC-"));
  const names = new Set();
  for (const d of dirs) {
    const mf = join(WIKI_RAW_SOURCES, d, "manifest.json");
    try {
      const m = JSON.parse(readFileSync(mf, "utf-8"));
      if (m.source) names.add(m.source);
    } catch { /* skip unreadable */ }
  }
  return names;
}

// ── 主流程 ──
async function main() {
  const today = fmtDate();
  console.log(`📥 Wiki 批量捕获 · ${today}\n`);

  if (!existsSync(WIKI_RAW_SOURCES)) {
    console.log(`❌ Wiki 源目录不存在: ${WIKI_RAW_SOURCES}`);
    console.log("   请先运行 pi 初始化 wiki (首次启动会自动创建)");
    process.exit(1);
  }

  // 扫描核心指南
  const files = findCoreGuides();
  if (files.length === 0) {
    console.log("⚠️  未找到核心指南文件");
    process.exit(0);
  }

  if (onlyList) {
    console.log(`📋 待捕获核心指南 (${files.length} 份):\n`);
    for (const f of files) {
      const srcPath = join(RAW_TXT_DIR, f);
      const size = existsSync(srcPath)
        ? `${(readFileSync(srcPath, "utf-8").length / 1024).toFixed(0)}KB`
        : "N/A";
      console.log(`   ${f} (${size})`);
    }
    process.exit(0);
  }

  // 获取起始序号 & 已捕获文件名
  const maxSeq = getMaxSeq();
  const capturedNames = getCapturedFilenames();

  // ── 创建源包 ──
  let captured = 0;
  let skipped = 0;

  for (let i = 0; i < files.length; i++) {
    const fileName = files[i];

    // 去重：若文件名已在之前被捕获则跳过
    if (capturedNames.has(fileName)) {
      if (!dryRun) {
        console.log(`   ↺ ${fileName.slice(0, 50)} 已存在，跳过`);
      }
      skipped++;
      continue;
    }

    const sourceId = makeSourceId(maxSeq + captured + 1);
    const result = createSourcePacket(fileName, sourceId);

    if (result) {
      captured++;
      console.log(`   ${dryRun ? "📄 [dry-run]" : "✅"} ${sourceId}: ${result.title.slice(0, 50)} (${(result.chars / 1024).toFixed(0)}KB)`);
    } else {
      skipped++;
    }
  }

  console.log(`\n📊 汇总: ${captured} 捕获, ${skipped} 跳过（已存在/无效）`);

  if (dryRun) {
    process.exit(0);
  }

  if (captured === 0) {
    console.log("   无需摄入 (所有文件已捕获)");
    process.exit(0);
  }

  // ── 提示下一步 ──
  console.log(`\n⏳ 源包就绪，接下来需要运行 wiki_ingest:`);
  console.log(`   npm run pi:chat -- -p "Run wiki_ingest to process ${captured} newly captured guideline sources into wiki pages"`);
}

main().catch((e) => {
  console.error(`❌ 批量捕获失败: ${e.message}`);
  process.exit(1);
});
