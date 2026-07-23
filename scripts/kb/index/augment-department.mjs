/**
 * augment-department.mjs — 指南索引科室标注
 *
 * 读取 .guide-index.json，根据疾病→科室映射（复用 DZ_CATEGORIES），
 * 为每份指南添加 department 字段，输出增强后的索引。
 *
 * 科室路由的好处：
 *   1. 检索时前过滤：仅匹配目标科室的指南（加速 30-50%）
 *   2. LLM 上下文感知：知道参考的是哪个科室的指南
 *   3. 未来按科室分库的基础
 *
 * 用途:
 *   node scripts/kb/index/augment-department.mjs          # 标注并写入
 *   node scripts/kb/index/augment-department.mjs --check  # 仅预览
 *
 * 输出: data/kb/.guide-index.json（原地更新）
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..", "..");
const INDEX_PATH = join(ROOT, "data", "kb", ".guide-index.json");

// ── 疾病→科室映射（与 guide-router/route.mjs 的 DZ_CATEGORIES 一一对应）──
// 增强：增加了科室的正式中文名
const DISEASE_TO_DEPT = {
  // 代谢
  "糖尿病": "内分泌代谢科", "糖尿": "内分泌代谢科", "肥胖": "内分泌代谢科",
  "高血糖": "内分泌代谢科", "高脂": "内分泌代谢科", "血脂": "内分泌代谢科",
  "痛风": "风湿免疫科", "高尿酸": "风湿免疫科",
  // 骨骼
  "骨质疏松": "骨科", "骨松": "骨科", "骨折": "骨科", "骨关节": "骨科",
  "关节炎": "风湿免疫科", "关节": "骨科",
  // 心血管
  "高血压": "心血管内科", "冠心病": "心血管内科", "心梗": "心血管内科",
  "心衰": "心血管内科", "心力衰竭": "心血管内科", "心肌梗死": "心血管内科",
  "房颤": "心血管内科", "心律": "心血管内科", "心绞痛": "心血管内科",
  "冠脉": "心血管内科", "冠状动脉": "心血管内科",
  // 脑血管/神经
  "脑卒中": "神经内科", "中风": "神经内科", "卒中": "神经内科",
  "癫痫": "神经内科", "帕金森": "神经内科", "痴呆": "神经内科",
  "脑梗": "神经内科", "阿兹海默": "神经内科",
  // 呼吸
  "肺炎": "呼吸内科", "哮喘": "呼吸内科", "慢阻肺": "呼吸内科",
  "COPD": "呼吸内科", "肺结核": "呼吸内科", "结核": "感染科",
  // 消化
  "幽门螺杆菌": "消化内科", "胃炎": "消化内科", "溃疡": "消化内科",
  "胰腺炎": "消化内科", "肝硬化": "消化内科", "肝炎": "感染科",
  // 肿瘤
  "肝癌": "肿瘤科", "肺癌": "肿瘤科", "乳腺癌": "肿瘤科", "胃癌": "肿瘤科",
  "肠癌": "肿瘤科", "食管癌": "肿瘤科", "甲状腺癌": "肿瘤科",
  "宫颈癌": "肿瘤科", "卵巢癌": "肿瘤科", "前列腺癌": "肿瘤科",
  "黑色素瘤": "肿瘤科", "淋巴瘤": "肿瘤科", "白血病": "血液科",
  // 肾脏
  "肾病": "肾内科", "透析": "肾内科", "血透": "肾内科",
  // 血液
  "贫血": "血液科", "血友病": "血液科", "溶血": "血液科",
  // 感染
  "艾滋病": "感染科", "HIV": "感染科", "乙肝": "感染科", "乙型肝炎": "感染科",
  "新冠": "感染科", "冠状病毒": "感染科",
  // 妇产
  "妊娠": "妇产科", "孕妇": "妇产科", "产后": "妇产科", "胎盘": "妇产科",
  "哺乳": "妇产科", "围产": "妇产科", "宫颈": "妇产科",
  "妇科": "妇产科", "剖宫产": "妇产科",
  // 儿科
  "儿童": "儿科", "小儿": "儿科", "新生儿": "儿科", "婴幼儿": "儿科",
  // 老年
  "老年": "老年科", "高龄": "老年科",
  // 口腔
  "口腔": "口腔科", "牙": "口腔科", "颌": "口腔科", "腭": "口腔科",
  // 精神
  "抑郁": "精神科", "焦虑": "精神科", "失眠": "精神科", "精神": "精神科",
  // 皮肤
  "皮肤": "皮肤科", "皮炎": "皮肤科", "皮疹": "皮肤科",
  "过敏": "变态反应科",
  // 内分泌
  "甲状腺": "内分泌代谢科", "甲亢": "内分泌代谢科", "甲减": "内分泌代谢科",
  // 耳鼻喉
  "耳": "耳鼻喉科", "鼻": "耳鼻喉科", "喉": "耳鼻喉科", "咽": "耳鼻喉科",
  // 眼科
  "眼": "眼科", "视力": "眼科", "白内障": "眼科", "青光眼": "眼科",
  // 泌尿
  "前列腺": "泌尿外科", "膀胱": "泌尿外科", "尿路": "泌尿外科",
  // 普外
  "阑尾": "普通外科", "疝": "普通外科", "胆囊": "普通外科", "胆": "普通外科",
  "胰腺外科": "普通外科", "胃肠": "普通外科", "痔": "普通外科",
  // 心胸外科
  "心脏": "心血管内科", "肺": "呼吸内科", "胸": "胸外科", "食管": "胸外科",
  // 骨科
  "脊柱": "骨科", "椎": "骨科", "髋": "骨科", "膝": "骨科", "肩": "骨科",
};

// 通用科室标签（用于标题匹配兜底）
const TITLE_DEPT_PATTERNS = [
  { pattern: /儿科|小儿|新生儿|婴幼儿/, dept: "儿科" },
  { pattern: /妇产|妊娠|孕妇|产后|围产|哺乳/, dept: "妇产科" },
  { pattern: /老年/, dept: "老年科" },
  { pattern: /精神|抑郁|焦虑/, dept: "精神科" },
  { pattern: /口腔/, dept: "口腔科" },
  { pattern: /皮肤/, dept: "皮肤科" },
  { pattern: /眼/, dept: "眼科" },
  { pattern: /耳鼻喉|咽喉/, dept: "耳鼻喉科" },
  { pattern: /肿瘤|癌/, dept: "肿瘤科" },
  { pattern: /心血管|高血压|冠心病|心衰|房颤|心律/, dept: "心血管内科" },
  { pattern: /神经|脑卒中|脑梗|癫痫|帕金森/, dept: "神经内科" },
  { pattern: /呼吸|肺炎|哮喘|慢阻肺|肺/, dept: "呼吸内科" },
  { pattern: /消化|胃肠|肝|胰腺|胆/, dept: "消化内科" },
  { pattern: /肾|透析|泌尿/, dept: "肾内科" },
  { pattern: /血液|贫血/, dept: "血液科" },
  { pattern: /感染|结核|乙肝|艾滋/, dept: "感染科" },
  { pattern: /内分泌|甲状腺|糖尿|代谢/, dept: "内分泌代谢科" },
  { pattern: /骨|关节|脊柱/, dept: "骨科" },
  { pattern: /风湿/, dept: "风湿免疫科" },
  { pattern: /麻醉/, dept: "麻醉科" },
  { pattern: /急诊/, dept: "急诊科" },
  { pattern: /重症|ICU/, dept: "重症医学科" },
  { pattern: /影像|放射|超声/, dept: "医学影像科" },
  { pattern: /检验/, dept: "检验科" },
  { pattern: /病理/, dept: "病理科" },
  { pattern: /康复/, dept: "康复医学科" },
  { pattern: /护理/, dept: "护理部" },
  { pattern: /药学|药物/, dept: "药剂科" },
  { pattern: /中医/, dept: "中医科" },
  { pattern: /营养/, dept: "营养科" },
  { pattern: /全科/, dept: "全科医学科" },
  { pattern: /介入/, dept: "介入科" },
];

/**
 * 根据疾病名推断科室。
 */
function diseaseToDept(diseaseName) {
  if (!diseaseName) return null;
  const lower = diseaseName.toLowerCase();
  for (const [key, dept] of Object.entries(DISEASE_TO_DEPT)) {
    if (lower.includes(key)) return dept;
  }
  return null;
}

/**
 * 根据指南标题推断科室。
 */
function titleToDept(title) {
  if (!title) return null;
  for (const { pattern, dept } of TITLE_DEPT_PATTERNS) {
    if (pattern.test(title)) return dept;
  }
  return null;
}

function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--check");

  if (!existsSync(INDEX_PATH)) {
    console.error(`❌ 指南索引不存在: ${INDEX_PATH}`);
    console.error(`   请先运行 kb:index`);
    process.exit(1);
  }

  const idx = JSON.parse(readFileSync(INDEX_PATH, "utf-8"));
  const guideMap = idx.guideMap || {};
  const guideKeys = Object.keys(guideMap);
  console.log(`\n═══ 指南索引科室标注 ═══\n`);
  console.log(`指南总数: ${guideKeys.length}`);

  let withDept = 0;
  let withoutDept = 0;
  const deptCounts = {};

  for (const [title, info] of Object.entries(guideMap)) {
    // 已有 department 且非"其他"则跳过
    if (info.department && info.department !== "其他" && info.department !== "待分类") {
      withDept++;
      deptCounts[info.department] = (deptCounts[info.department] || 0) + 1;
      continue;
    }

    // 先根据 disease 字段判断
    let dept = diseaseToDept(info.disease || info.normalizedDisease || "");
    // 再根据 title 判断
    if (!dept) dept = titleToDept(title);
    // 再根据 keywords 判断
    if (!dept && info.keywords) {
      const kwText = (Array.isArray(info.keywords) ? info.keywords.join(" ") : info.keywords);
      dept = titleToDept(kwText);
    }

    if (dept) {
      info.department = dept;
      withDept++;
      deptCounts[dept] = (deptCounts[dept] || 0) + 1;
    } else {
      info.department = "待分类";
      withoutDept++;
    }
  }

  // 排序输出
  const sortedDepts = Object.entries(deptCounts).sort((a, b) => b[1] - a[1]);

  console.log(`\n── 科室分布 ──`);
  for (const [dept, count] of sortedDepts) {
    console.log(`  ${dept.padEnd(12)} ${count} 篇`);
  }

  if (withoutDept > 0) {
    console.log(`\n⚠️  ${withoutDept} 篇指南未分类（department="待分类"）`);
  }

  console.log(`\n覆盖率: ${((withDept / guideKeys.length) * 100).toFixed(1)}% (${withDept}/${guideKeys.length})`);

  // 列出未分类指南
  const unclassified = Object.entries(guideMap)
    .filter(([, info]) => info.department === "待分类")
    .map(([title]) => title);
  if (unclassified.length > 0) {
    console.log(`\n未分类指南:`);
    for (const t of unclassified) {
      console.log(`  · ${t}`);
    }
  }

  if (dryRun) {
    console.log(`\n⚠️  dry-run 模式，未写入。`);
    process.exit(0);
  }

  // 写回
  idx.guideMap = guideMap;
  writeFileSync(INDEX_PATH, JSON.stringify(idx, null, 2), "utf-8");
  console.log(`\n✅ 已写入 ${INDEX_PATH}`);
}

main();
