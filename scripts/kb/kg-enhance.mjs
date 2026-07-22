/**
 * 知识图谱增强脚本（规则注入）
 * 读取现有 .knowledge-graph.json，注入已知临床实体的规则知识，
 * 补 LLM 抽取管线遗漏的典型症状/药物/检查等。
 *
 * 用法: node scripts/kb/kg-enhance.mjs
 * 输出: data/kb/.knowledge-graph.json（原地增强）
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const GRAPH_FILE = join(ROOT, "data", "kb", ".knowledge-graph.json");

// ── 规则增强：注入已知临床实体 ──
const KNOWN_ENTITIES = [
  // ── 糖尿病 ──
  { disease: "糖尿病", entityType: "symptom", entityName: "多饮（烦渴）", relation: "has_symptom" },
  { disease: "糖尿病", entityType: "symptom", entityName: "多食", relation: "has_symptom" },
  { disease: "糖尿病", entityType: "symptom", entityName: "多尿", relation: "has_symptom" },
  { disease: "糖尿病", entityType: "symptom", entityName: "体重下降", relation: "has_symptom" },
  { disease: "糖尿病", entityType: "symptom", entityName: "视力模糊", relation: "has_symptom" },
  { disease: "糖尿病", entityType: "symptom", entityName: "伤口愈合缓慢", relation: "has_symptom" },
  { disease: "糖尿病", entityType: "examination", entityName: "空腹血糖", relation: "diagnosed_by" },
  { disease: "糖尿病", entityType: "examination", entityName: "OGTT 2小时血糖", relation: "diagnosed_by" },
  { disease: "糖尿病", entityType: "examination", entityName: "糖化血红蛋白（HbA1c）", relation: "diagnosed_by" },
  { disease: "糖尿病", entityType: "drug", entityName: "二甲双胍", relation: "treated_with" },
  { disease: "糖尿病", entityType: "drug", entityName: "胰岛素", relation: "treated_with" },
  { disease: "糖尿病", entityType: "drug", entityName: "SGLT2抑制剂", relation: "treated_with" },
  { disease: "糖尿病", entityType: "drug", entityName: "GLP-1受体激动剂", relation: "treated_with" },
  { disease: "糖尿病", entityType: "drug", entityName: "DPP-4抑制剂", relation: "treated_with" },
  { disease: "糖尿病", entityType: "riskFactor", entityName: "超重/肥胖", relation: "has_risk" },
  { disease: "糖尿病", entityType: "riskFactor", entityName: "家族史", relation: "has_risk" },
  { disease: "糖尿病", entityType: "riskFactor", entityName: "缺乏运动", relation: "has_risk" },
  { disease: "糖尿病", entityType: "riskFactor", entityName: "高龄", relation: "has_risk" },
  { disease: "糖尿病", entityType: "treatment", entityName: "医学营养治疗", relation: "treated_by" },
  { disease: "糖尿病", entityType: "treatment", entityName: "运动治疗", relation: "treated_by" },
  // ── 高血压 ──
  { disease: "高血压", entityType: "symptom", entityName: "头痛", relation: "has_symptom" },
  { disease: "高血压", entityType: "symptom", entityName: "头晕", relation: "has_symptom" },
  { disease: "高血压", entityType: "symptom", entityName: "心悸", relation: "has_symptom" },
  { disease: "高血压", entityType: "symptom", entityName: "颈项僵硬", relation: "has_symptom" },
  { disease: "高血压", entityType: "examination", entityName: "诊室血压测量", relation: "diagnosed_by" },
  { disease: "高血压", entityType: "examination", entityName: "动态血压监测", relation: "diagnosed_by" },
  { disease: "高血压", entityType: "examination", entityName: "家庭自测血压", relation: "diagnosed_by" },
  { disease: "高血压", entityType: "drug", entityName: "ACEI", relation: "treated_with" },
  { disease: "高血压", entityType: "drug", entityName: "ARB", relation: "treated_with" },
  { disease: "高血压", entityType: "drug", entityName: "钙通道阻滞剂（CCB）", relation: "treated_with" },
  { disease: "高血压", entityType: "drug", entityName: "噻嗪类利尿剂", relation: "treated_with" },
  { disease: "高血压", entityType: "riskFactor", entityName: "高盐饮食", relation: "has_risk" },
  { disease: "高血压", entityType: "riskFactor", entityName: "肥胖", relation: "has_risk" },
  { disease: "高血压", entityType: "riskFactor", entityName: "饮酒", relation: "has_risk" },
  // ── 冠心病 ──
  { disease: "冠心病", entityType: "symptom", entityName: "胸痛（心绞痛）", relation: "has_symptom" },
  { disease: "冠心病", entityType: "symptom", entityName: "胸闷", relation: "has_symptom" },
  { disease: "冠心病", entityType: "symptom", entityName: "气促", relation: "has_symptom" },
  { disease: "冠心病", entityType: "examination", entityName: "心电图（ECG）", relation: "diagnosed_by" },
  { disease: "冠心病", entityType: "examination", entityName: "冠状动脉造影", relation: "diagnosed_by" },
  { disease: "冠心病", entityType: "examination", entityName: "心肌酶谱", relation: "diagnosed_by" },
  { disease: "冠心病", entityType: "drug", entityName: "阿司匹林", relation: "treated_with" },
  { disease: "冠心病", entityType: "drug", entityName: "他汀类", relation: "treated_with" },
  { disease: "冠心病", entityType: "drug", entityName: "硝酸酯类", relation: "treated_with" },
  { disease: "冠心病", entityType: "riskFactor", entityName: "高血压", relation: "has_risk" },
  { disease: "冠心病", entityType: "riskFactor", entityName: "高脂血症", relation: "has_risk" },
  { disease: "冠心病", entityType: "riskFactor", entityName: "吸烟", relation: "has_risk" },
  { disease: "冠心病", entityType: "riskFactor", entityName: "糖尿病", relation: "has_risk" },
  // ── 慢阻肺 ──
  { disease: "慢性阻塞性肺疾病", entityType: "symptom", entityName: "慢性咳嗽", relation: "has_symptom" },
  { disease: "慢性阻塞性肺疾病", entityType: "symptom", entityName: "咳痰", relation: "has_symptom" },
  { disease: "慢性阻塞性肺疾病", entityType: "symptom", entityName: "气短/呼吸困难", relation: "has_symptom" },
  { disease: "慢性阻塞性肺疾病", entityType: "examination", entityName: "肺功能检查", relation: "diagnosed_by" },
  { disease: "慢性阻塞性肺疾病", entityType: "examination", entityName: "胸部X线", relation: "diagnosed_by" },
  { disease: "慢性阻塞性肺疾病", entityType: "riskFactor", entityName: "吸烟", relation: "has_risk" },
  { disease: "慢性阻塞性肺疾病", entityType: "riskFactor", entityName: "空气污染", relation: "has_risk" },
  // ── 脑卒中 ──
  { disease: "脑卒中", entityType: "symptom", entityName: "偏瘫", relation: "has_symptom" },
  { disease: "脑卒中", entityType: "symptom", entityName: "言语障碍", relation: "has_symptom" },
  { disease: "脑卒中", entityType: "symptom", entityName: "面部歪斜", relation: "has_symptom" },
  { disease: "脑卒中", entityType: "symptom", entityName: "意识障碍", relation: "has_symptom" },
  { disease: "脑卒中", entityType: "examination", entityName: "头颅CT", relation: "diagnosed_by" },
  { disease: "脑卒中", entityType: "examination", entityName: "头颅MRI", relation: "diagnosed_by" },
  { disease: "脑卒中", entityType: "drug", entityName: "rt-PA溶栓", relation: "treated_with" },
  { disease: "脑卒中", entityType: "drug", entityName: "抗血小板药", relation: "treated_with" },
  { disease: "脑卒中", entityType: "riskFactor", entityName: "高血压", relation: "has_risk" },
  { disease: "脑卒中", entityType: "riskFactor", entityName: "房颤", relation: "has_risk" },
  // ── 肺炎 ──
  { disease: "肺炎", entityType: "symptom", entityName: "发热", relation: "has_symptom" },
  { disease: "肺炎", entityType: "symptom", entityName: "咳嗽", relation: "has_symptom" },
  { disease: "肺炎", entityType: "symptom", entityName: "咳痰", relation: "has_symptom" },
  { disease: "肺炎", entityType: "symptom", entityName: "胸痛", relation: "has_symptom" },
  { disease: "肺炎", entityType: "examination", entityName: "胸部X线", relation: "diagnosed_by" },
  { disease: "肺炎", entityType: "examination", entityName: "血常规", relation: "diagnosed_by" },
  { disease: "肺炎", entityType: "examination", entityName: "降钙素原（PCT）", relation: "diagnosed_by" },
  // ── 骨质疏松 ──
  { disease: "骨质疏松症", entityType: "symptom", entityName: "骨痛", relation: "has_symptom" },
  { disease: "骨质疏松症", entityType: "symptom", entityName: "身材变矮", relation: "has_symptom" },
  { disease: "骨质疏松症", entityType: "symptom", entityName: "驼背", relation: "has_symptom" },
  { disease: "骨质疏松症", entityType: "examination", entityName: "骨密度测定（DXA）", relation: "diagnosed_by" },
  { disease: "骨质疏松症", entityType: "drug", entityName: "双膦酸盐", relation: "treated_with" },
  { disease: "骨质疏松症", entityType: "drug", entityName: "钙剂", relation: "treated_with" },
  { disease: "骨质疏松症", entityType: "drug", entityName: "维生素D", relation: "treated_with" },
  { disease: "骨质疏松症", entityType: "riskFactor", entityName: "绝经", relation: "has_risk" },
  { disease: "骨质疏松症", entityType: "riskFactor", entityName: "高龄", relation: "has_risk" },
  { disease: "骨质疏松症", entityType: "riskFactor", entityName: "低体重", relation: "has_risk" },
  // ── 心衰 ──
  { disease: "心力衰竭", entityType: "symptom", entityName: "呼吸困难", relation: "has_symptom" },
  { disease: "心力衰竭", entityType: "symptom", entityName: "水肿", relation: "has_symptom" },
  { disease: "心力衰竭", entityType: "symptom", entityName: "乏力", relation: "has_symptom" },
  { disease: "心力衰竭", entityType: "examination", entityName: "超声心动图", relation: "diagnosed_by" },
  { disease: "心力衰竭", entityType: "examination", entityName: "BNP/NT-proBNP", relation: "diagnosed_by" },
  { disease: "心力衰竭", entityType: "drug", entityName: "ACEI/ARB", relation: "treated_with" },
  { disease: "心力衰竭", entityType: "drug", entityName: "β受体阻滞剂", relation: "treated_with" },
  { disease: "心力衰竭", entityType: "drug", entityName: "利尿剂", relation: "treated_with" },
  // ── 乙肝 ──
  { disease: "慢性乙型肝炎", entityType: "symptom", entityName: "乏力", relation: "has_symptom" },
  { disease: "慢性乙型肝炎", entityType: "symptom", entityName: "食欲减退", relation: "has_symptom" },
  { disease: "慢性乙型肝炎", entityType: "symptom", entityName: "黄疸", relation: "has_symptom" },
  { disease: "慢性乙型肝炎", entityType: "examination", entityName: "HBsAg检测", relation: "diagnosed_by" },
  { disease: "慢性乙型肝炎", entityType: "examination", entityName: "HBV DNA检测", relation: "diagnosed_by" },
  { disease: "慢性乙型肝炎", entityType: "examination", entityName: "肝功能检测", relation: "diagnosed_by" },
  { disease: "慢性乙型肝炎", entityType: "drug", entityName: "恩替卡韦", relation: "treated_with" },
  { disease: "慢性乙型肝炎", entityType: "drug", entityName: "替诺福韦", relation: "treated_with" },
  { disease: "慢性乙型肝炎", entityType: "riskFactor", entityName: "母婴传播", relation: "has_risk" },
  { disease: "慢性乙型肝炎", entityType: "riskFactor", entityName: "血液传播", relation: "has_risk" },
  // ── 肺结核 ──
  { disease: "肺结核", entityType: "symptom", entityName: "咳嗽", relation: "has_symptom" },
  { disease: "肺结核", entityType: "symptom", entityName: "咳血", relation: "has_symptom" },
  { disease: "肺结核", entityType: "symptom", entityName: "午后低热", relation: "has_symptom" },
  { disease: "肺结核", entityType: "symptom", entityName: "盗汗", relation: "has_symptom" },
  { disease: "肺结核", entityType: "examination", entityName: "胸部X线", relation: "diagnosed_by" },
  { disease: "肺结核", entityType: "examination", entityName: "结核菌素试验（PPD）", relation: "diagnosed_by" },
  { disease: "肺结核", entityType: "examination", entityName: "痰涂片抗酸染色", relation: "diagnosed_by" },
  { disease: "肺结核", entityType: "drug", entityName: "异烟肼", relation: "treated_with" },
  { disease: "肺结核", entityType: "drug", entityName: "利福平", relation: "treated_with" },
  { disease: "肺结核", entityType: "drug", entityName: "吡嗪酰胺", relation: "treated_with" },
  { disease: "肺结核", entityType: "drug", entityName: "乙胺丁醇", relation: "treated_with" },
  // ── 类风湿关节炎 ──
  { disease: "类风湿关节炎", entityType: "symptom", entityName: "关节肿痛", relation: "has_symptom" },
  { disease: "类风湿关节炎", entityType: "symptom", entityName: "晨僵", relation: "has_symptom" },
  { disease: "类风湿关节炎", entityType: "examination", entityName: "类风湿因子（RF）", relation: "diagnosed_by" },
  { disease: "类风湿关节炎", entityType: "examination", entityName: "抗CCP抗体", relation: "diagnosed_by" },
  { disease: "类风湿关节炎", entityType: "drug", entityName: "甲氨蝶呤", relation: "treated_with" },
  { disease: "类风湿关节炎", entityType: "drug", entityName: "来氟米特", relation: "treated_with" },
  // ── 甲状腺功能亢进 ──
  { disease: "甲状腺功能亢进症", entityType: "symptom", entityName: "心悸", relation: "has_symptom" },
  { disease: "甲状腺功能亢进症", entityType: "symptom", entityName: "手抖", relation: "has_symptom" },
  { disease: "甲状腺功能亢进症", entityType: "symptom", entityName: "多汗", relation: "has_symptom" },
  { disease: "甲状腺功能亢进症", entityType: "symptom", entityName: "消瘦", relation: "has_symptom" },
  { disease: "甲状腺功能亢进症", entityType: "examination", entityName: "甲状腺功能检测（TSH/FT3/FT4）", relation: "diagnosed_by" },
  { disease: "甲状腺功能亢进症", entityType: "drug", entityName: "甲巯咪唑", relation: "treated_with" },
  { disease: "甲状腺功能亢进症", entityType: "drug", entityName: "丙硫氧嘧啶", relation: "treated_with" },
  // ── 癫痫 ──
  { disease: "癫痫", entityType: "symptom", entityName: "抽搐", relation: "has_symptom" },
  { disease: "癫痫", entityType: "symptom", entityName: "意识丧失", relation: "has_symptom" },
  { disease: "癫痫", entityType: "examination", entityName: "脑电图（EEG）", relation: "diagnosed_by" },
  { disease: "癫痫", entityType: "examination", entityName: "头颅MRI", relation: "diagnosed_by" },
  { disease: "癫痫", entityType: "drug", entityName: "卡马西平", relation: "treated_with" },
  { disease: "癫痫", entityType: "drug", entityName: "丙戊酸", relation: "treated_with" },
  { disease: "癫痫", entityType: "drug", entityName: "左乙拉西坦", relation: "treated_with" },
  // ── 妊娠期高血糖 ──
  { disease: "妊娠期高血糖", entityType: "symptom", entityName: "多饮", relation: "has_symptom" },
  { disease: "妊娠期高血糖", entityType: "symptom", entityName: "多尿", relation: "has_symptom" },
  { disease: "妊娠期高血糖", entityType: "examination", entityName: "空腹血糖", relation: "diagnosed_by" },
  { disease: "妊娠期高血糖", entityType: "examination", entityName: "OGTT", relation: "diagnosed_by" },
  { disease: "妊娠期高血糖", entityType: "examination", entityName: "糖化血红蛋白", relation: "diagnosed_by" },
  { disease: "妊娠期高血糖", entityType: "riskFactor", entityName: "高龄妊娠", relation: "has_risk" },
  { disease: "妊娠期高血糖", entityType: "riskFactor", entityName: "肥胖", relation: "has_risk" },
  { disease: "妊娠期高血糖", entityType: "riskFactor", entityName: "糖尿病家族史", relation: "has_risk" },
  { disease: "妊娠期高血糖", entityType: "treatment", entityName: "医学营养治疗", relation: "treated_by" },
  { disease: "妊娠期高血糖", entityType: "treatment", entityName: "胰岛素治疗", relation: "treated_by" },
  // ── 严重过敏反应 ──
  { disease: "严重过敏反应", entityType: "symptom", entityName: "荨麻疹", relation: "has_symptom" },
  { disease: "严重过敏反应", entityType: "symptom", entityName: "呼吸困难", relation: "has_symptom" },
  { disease: "严重过敏反应", entityType: "symptom", entityName: "喉头水肿", relation: "has_symptom" },
  { disease: "严重过敏反应", entityType: "symptom", entityName: "血压下降", relation: "has_symptom" },
  { disease: "严重过敏反应", entityType: "examination", entityName: "血清类胰蛋白酶", relation: "diagnosed_by" },
  { disease: "严重过敏反应", entityType: "examination", entityName: "过敏原检测", relation: "diagnosed_by" },
  { disease: "严重过敏反应", entityType: "drug", entityName: "肾上腺素", relation: "treated_with" },
  { disease: "严重过敏反应", entityType: "drug", entityName: "抗组胺药", relation: "treated_with" },
  { disease: "严重过敏反应", entityType: "drug", entityName: "糖皮质激素", relation: "treated_with" },
  { disease: "严重过敏反应", entityType: "treatment", entityName: "肾上腺素自动注射", relation: "treated_by" },
  // ── 老年人多重用药 ──
  { disease: "老年人多重用药", entityType: "riskFactor", entityName: "高龄", relation: "has_risk" },
  { disease: "老年人多重用药", entityType: "riskFactor", entityName: "多病共存", relation: "has_risk" },
  { disease: "老年人多重用药", entityType: "riskFactor", entityName: "肝肾功能减退", relation: "has_risk" },
  { disease: "老年人多重用药", entityType: "riskFactor", entityName: "多种药物联用", relation: "has_risk" },
  { disease: "老年人多重用药", entityType: "drug", entityName: "用药精简评估", relation: "treated_with" },
  { disease: "老年人多重用药", entityType: "treatment", entityName: "Beers标准评估", relation: "treated_by" },
  { disease: "老年人多重用药", entityType: "treatment", entityName: "药物重整", relation: "treated_by" },
];

async function main() {
  const raw = JSON.parse(await readFile(GRAPH_FILE, "utf-8"));
  const existing = raw.entities || [];

  // 建立去重索引
  const unique = new Map();
  for (const e of existing) {
    const key = `${e.disease}|${e.entityType}|${e.entityName}|${e.relation}`;
    if (!unique.has(key)) unique.set(key, e);
  }

  // 获取 KG 中实际使用的疾病名称集合
  const existingDiseaseNames = new Set(existing.map((e) => e.disease));

  // 注入已知实体（去重）
  let injected = 0;
  for (const ke of KNOWN_ENTITIES) {
    // 尝试将已知实体的 disease 名称匹配到 KG 中已有的疾病名
    let matchedDisease = null;
    const keNorm = ke.disease.toLowerCase();
    for (const ed of existingDiseaseNames) {
      const edNorm = ed.toLowerCase();
      if (edNorm === keNorm || edNorm.includes(keNorm) || keNorm.includes(edNorm)) {
        matchedDisease = ed;
        break;
      }
    }
    const entry = {
      disease: matchedDisease || ke.disease,
      entityType: ke.entityType,
      entityName: ke.entityName,
      relation: ke.relation,
      source: "临床知识增强",
    };
    const key = `${entry.disease}|${entry.entityType}|${entry.entityName}|${entry.relation}`;
    if (!unique.has(key)) {
      unique.set(key, entry);
      injected++;
    }
  }

  const enhanced = Array.from(unique.values());
  const stats = {
    totalEntities: enhanced.length,
    uniqueEntities: enhanced.length,
    diseaseCount: new Set(enhanced.map((e) => e.disease)).size,
    drugCount: enhanced.filter((e) => e.entityType === "drug").length,
    symptomCount: enhanced.filter((e) => e.entityType === "symptom").length,
    examCount: enhanced.filter((e) => e.entityType === "examination").length,
    riskCount: enhanced.filter((e) => e.entityType === "riskFactor").length,
    treatmentCount: enhanced.filter((e) => e.entityType === "treatment").length,
  };

  const graph = {
    generatedAt: raw.generatedAt || new Date().toISOString(),
    enhancedAt: new Date().toISOString(),
    stats,
    entities: enhanced,
  };

  await writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), "utf-8");

  console.log(`知识图谱增强完成`);
  console.log(`  原始实体: ${existing.length}`);
  console.log(`  注入实体: ${injected}`);
  console.log(`  增强总计: ${stats.uniqueEntities}`);
  console.log(`  疾病数: ${stats.diseaseCount}`);
  console.log(`  药物: ${stats.drugCount}  症状: ${stats.symptomCount}`);
  console.log(`  检查: ${stats.examCount}  危险因素: ${stats.riskCount}  治疗: ${stats.treatmentCount}`);
}

main().catch(console.error);
