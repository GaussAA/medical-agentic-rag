/**
 * gap-analysis.mjs — 评测覆盖缺口分析
 *
 * 对比 gold-answers.json 的 gtSources 与 KB outline，
 * 找出「高临床价值的国内诊疗指南」中尚未被评测覆盖的。
 * 输出按临床优先级排序的缺口清单。
 *
 * 用法: node scripts/kb/gap-analysis.mjs
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");

// 加载 gold-answers.json
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));

// 收集所有 gtSources
const coveredSources = new Set();
for (const item of gold.items) {
  for (const src of item.gtSources || []) {
    // 归一化：去 .pdf 后缀
    coveredSources.add(src.replace(/\.pdf$/i, ""));
  }
}

// 加载 outline
const OUTLINE_PATH = join(ROOT, "data", "kb", ".outline.json");
if (!existsSync(OUTLINE_PATH)) {
  console.error("[gap] outline 不存在。请先运行 kb:outline");
  process.exit(1);
}
const outline = JSON.parse(readFileSync(OUTLINE_PATH, "utf-8"));
const allGuides = outline.guides || [];

// 归一化辅助
function normalize(s) {
  return s
    .replace(/[\s（）]/g, "")
    .replace(/[（(][^)）]*[)）]/g, "") // 去括号内容
    .replace(/\d{4}版?$/, "")          // 去版本年份
    .toLowerCase();
}

// 判断是否被覆盖：gtSources 中任一源名与 guide title 归一化后匹配
function isCovered(title) {
  const nTitle = normalize(title);
  for (const src of coveredSources) {
    const nSrc = normalize(src);
    if (nTitle.includes(nSrc) || nSrc.includes(nTitle)) return true;
  }
  return false;
}

// 高优先级国内指南：排除行政/检验/标准/食品/职业卫生类
const EXCLUDE_PATTERNS = [
  /体格检/, /体检项目/, /流程图/, /工作流程/,
  /质量控制指标/, /质量安全/, /改进目标/,
  /评审标准/, /申请书/, /审查条件/, /备案指导/,
  /指导组成员/, /指导组章程/, /工作计划/, /工作指南.*2024版$/,
  /自查整改表/, /建设与服务指南/,
  /食品添加剂/, /新食品原料/, /食品相关产品/,
  /GBZ/, /WS[-\d]/, /WS-T/, // 职业卫生/检验标准
  /食养指南与科普/, /安宁疗护/, /养老服务机构/,
  /血站技术/, /生物医学新技术/,
  /国家卫生健康委关于修改/, /国家基本药物目录/,
  /EuropePMCOA/, /cvd-/, /resp-/, /neuro-/, /infect-/,
  /endo-/, /rheum-/, /gi-/, /nephro-/, /hemo-/,
  /htn-/, /cardio-/, /meta-/, /crit-/,
  /临床路径/, // 临床路径偏操作手册，非治疗指南
  /门诊诊疗规范/, /诊疗规范.*附件/,
  /患者健康服务规范/,
];

function isHighValue(title) {
  for (const p of EXCLUDE_PATTERNS) {
    if (p.test(title)) return false;
  }
  // 至少含"指南"、"共识"、"规范"、"诊疗方案"、"诊治指南"之一
  return /指南|共识|规范|诊疗方案|诊治指南|诊断.*标准/.test(title);
}

// 去重统计（同名 EuropePMCOA 多条只计一次）
const seen = new Set();
const gaps = [];
for (const g of allGuides) {
  const title = g.title;
  if (seen.has(title)) continue;
  seen.add(title);

  if (!isCovered(title) && isHighValue(title)) {
    gaps.push(title);
  }
}

// 临床优先级排序：按科室/病种价值
const PRIORITY_ORDER = [
  // 肿瘤 — 发病率前五
  /原发性肺癌/, /卵巢癌/, /食管癌/, /肾癌/, /膀胱癌/,
  /弥漫性大B细胞淋巴瘤/, /慢性淋巴细胞白血病/, /骨髓增生异常/,
  /子宫内膜癌/, /乳腺癌/, // 乳腺癌已有单独指南covered
  // 心血管
  /冠状动脉微血管/,
  // 内分泌
  /老年糖尿病/, /甲状腺结节/,
  // 消化
  /溃疡性结肠炎/, /克罗恩病/,
  // 儿科
  /儿童腺病毒/,
  // 呼吸
  /慢性阻塞性肺疾病患者健康/,
  // 其他高价值
  /原发性骨质疏松症/,
  /罕见病诊疗指南/,
];

function priority(title) {
  for (let i = 0; i < PRIORITY_ORDER.length; i++) {
    if (PRIORITY_ORDER[i].test(title)) return i;
  }
  return 999;
}

gaps.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));

// 输出
console.log("=".repeat(60));
console.log("  评测覆盖缺口分析");
console.log("=".repeat(60));
console.log(`gold 题目数: ${gold.items.length}`);
console.log(`已覆盖来源: ${coveredSources.size}`);
console.log(`KB 指南总数: ${allGuides.length}`);
console.log(`未覆盖的高价值国内指南: ${gaps.length}`);
console.log();
console.log("--- 高优先级缺口（按临床价值排序） ---");
console.log();

gaps.forEach((g, i) => {
  const rank = priority(g);
  const tag = rank < 5 ? "P0" : rank < 15 ? "P1" : "P2";
  const emoji = rank === 0 ? "🔴" : rank < 5 ? "🟠" : rank < 15 ? "🟡" : "⚪";
  console.log(`${emoji} [${tag}] #${i + 1}: ${g}`);
});

console.log();
console.log("--- 统计 ---");
console.log(`P0（极高优先级）: ${gaps.filter(g => priority(g) < 5).length}`);
console.log(`P1（高优先级）: ${gaps.filter(g => priority(g) >= 5 && priority(g) < 15).length}`);
console.log(`P2（中优先级）: ${gaps.filter(g => priority(g) >= 15 && priority(g) < 999).length}`);
console.log();
console.log("建议：每新增一题 = 一个科室/病种的质量锚点。首选 P0 级覆盖。");
