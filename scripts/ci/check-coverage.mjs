/**
 * scripts/ci/check-coverage.mjs
 *
 * 评测覆盖自动同步检查 —— KB 更新后自动检测是否有高价值指南未被评测覆盖。
 * 可在 kb:rebuild / kb:update / 每日检测后调用。
 *
 * 行为:
 *   · 无缺口 → exit 0，静默
 *   · 有 P0/P1 级缺口 → exit 1，输出警告（fail-closed 可阻断 CI/流程）
 *   · 仅 P2 级缺口 → exit 0，输出 WARN
 *
 * 用法:
 *   node scripts/ci/check-coverage.mjs               # 默认模式（P0/P1 阻塞）
 *   node scripts/ci/check-coverage.mjs --warn-only    # 所有缺口仅警告不阻断
 *   node scripts/ci/check-coverage.mjs --quiet        # 无缺口时静默退出
 */

import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const OUTLINE_PATH = join(ROOT, "data", "kb", ".outline.json");
const BASELINE_PATH = join(ROOT, "tests", "reports", "baseline.json");

// ---- 配置 ----
const EXCLUDE_PATTERNS = [
  /体格检/, /体检项目/, /流程图/, /工作流程/,
  /质量控制指标/, /质量安全/, /改进目标/,
  /评审标准/, /申请书/, /审查条件/, /备案指导/,
  /指导组成员/, /指导组章程/, /工作计划/, /工作指南.*2024版$/,
  /自查整改表/, /建设与服务指南/,
  /食品添加剂/, /新食品原料/, /食品相关产品/,
  /GBZ/, /WS[-\d]/, /WS-T/,
  /食养指南与科普/, /安宁疗护/, /养老服务机构/,
  /血站技术/, /生物医学新技术/,
  /国家卫生健康委关于修改/, /国家基本药物目录/,
  /EuropePMCOA/, /cvd-/, /resp-/, /neuro-/, /infect-/,
  /endo-/, /rheum-/, /gi-/, /nephro-/, /hemo-/,
  /htn-/, /cardio-/, /meta-/, /crit-/,
  /临床路径/, /门诊诊疗规范/, /诊疗规范.*附件/,
  /患者健康服务规范/,
];

function isHighValue(title) {
  for (const p of EXCLUDE_PATTERNS) {
    if (p.test(title)) return false;
  }
  return /指南|共识|规范|诊疗方案|诊治指南|诊断.*标准/.test(title);
}

function normalize(s) {
  return s
    .replace(/[\s（）]/g, "")
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/\d{4}版?$/, "")
    .toLowerCase();
}

const PRIORITY_RULES = [
  { name: "P0-癌种", test: /原发性肺癌|卵巢癌|食管癌|肾癌|膀胱癌/ },
  { name: "P0-高发", test: /子宫内膜癌|弥漫性大B细胞淋巴瘤|慢性淋巴细胞白血病|骨髓增生异常/ },
  { name: "P1-内科", test: /老年糖尿病|甲状腺结节|溃疡性结肠炎|克罗恩病/ },
  { name: "P1-心血管", test: /冠状动脉微血管/ },
  { name: "P2-儿科", test: /儿童腺病毒/ },
  { name: "P2-呼吸", test: /慢性阻塞性肺疾病患者健康/ },
];

function classifyPriority(title) {
  for (const rule of PRIORITY_RULES) {
    if (rule.test.test(title)) {
      if (rule.name.startsWith("P0")) return "P0";
      if (rule.name.startsWith("P1")) return "P1";
      return "P2";
    }
  }
  return "P2";
}

// ---- 核心检查 ----
export function checkCoverageGaps() {
  const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
  const outline = JSON.parse(readFileSync(OUTLINE_PATH, "utf-8"));

  const coveredSources = new Set();
  for (const item of gold.items) {
    for (const src of item.gtSources || []) {
      coveredSources.add(src.replace(/\.pdf$/i, ""));
    }
  }

  const allGuides = outline.guides || [];
  const seen = new Set();
  const gaps = [];

  for (const g of allGuides) {
    const title = g.title;
    if (seen.has(title)) continue;
    seen.add(title);

    // 跳过非高价值
    if (!isHighValue(title)) continue;

    // 检查是否已被覆盖
    const nTitle = normalize(title);
    let covered = false;
    for (const src of coveredSources) {
      const nSrc = normalize(src);
      if (nTitle.includes(nSrc) || nSrc.includes(nTitle)) {
        covered = true;
        break;
      }
    }
    if (!covered) {
      gaps.push({ title, priority: classifyPriority(title) });
    }
  }

  return {
    totalGuides: allGuides.length,
    coveredSources: coveredSources.size,
    totalItems: gold.items.length,
    gaps: gaps.sort((a, b) => {
      const p = { P0: 0, P1: 1, P2: 2 };
      return (p[a.priority] || 3) - (p[b.priority] || 3);
    }),
  };
}

// ---- CLI 入口 ----
function main() {
  const args = process.argv.slice(2);
  const WARN_ONLY = args.includes("--warn-only");
  const QUIET = args.includes("--quiet");

  if (!existsSync(OUTLINE_PATH)) {
    console.error("[coverage] outline 不存在，跳过覆盖检查。");
    process.exit(0);
  }

  let result;
  try {
    result = checkCoverageGaps();
  } catch (e) {
    console.error(`[coverage] 检查失败: ${e.message}`);
    process.exit(2);
  }

  const p0 = result.gaps.filter((g) => g.priority === "P0");
  const p1 = result.gaps.filter((g) => g.priority === "P1");
  const p2 = result.gaps.filter((g) => g.priority === "P2");

  if (result.gaps.length === 0) {
    if (!QUIET) {
      console.log(`[coverage] ✅ 全部高价值指南已有评测覆盖（${result.coveredSources}/${result.totalGuides}）`);
    }
    process.exit(0);
  }

  // 有缺口
  console.log(`[coverage] ⚠ 发现 ${result.gaps.length} 个未覆盖的高价值指南`);
  console.log(`           gold 题数: ${result.totalItems}，覆盖来源: ${result.coveredSources}/${result.totalGuides}`);
  console.log();

  if (p0.length > 0) {
    console.log(`  🔴 P0（极高优先级）: ${p0.length} 项`);
    for (const g of p0) console.log(`     ${g.title}`);
    console.log();
  }
  if (p1.length > 0) {
    console.log(`  🟠 P1（高优先级）: ${p1.length} 项`);
    for (const g of p1) console.log(`     ${g.title}`);
    console.log();
  }
  if (p2.length > 0) {
    console.log(`  ⚪ P2（中优先级）: ${p2.length} 项`);
    for (const g of p2) console.log(`     ${g.title}`);
    console.log();
  }

  if (p0.length > 0 || p1.length > 0) {
    console.log(`\n  💡 运行 node scripts/kb/inject-gold-answers.mjs 或手动编辑 tests/gold-answers.json 添加对应评测题。`);
    console.log(`  或运行 node scripts/kb/gap-analysis.mjs 查看完整缺口清单。`);
  }

  if (!WARN_ONLY && (p0.length > 0 || p1.length > 0)) {
    process.exit(1); // P0/P1 缺口→阻断
  }
  process.exit(0); // 仅 P2 或 warn-only → 放行
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
