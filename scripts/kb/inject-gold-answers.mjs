/**
 * scripts/kb/inject-gold-answers.mjs
 *
 * 为高优先级缺口注入新的 gold 评测题目。
 * 读取 gold-answers.json → 追加新条目 → 写回。
 *
 * 用法: node scripts/kb/inject-gold-answers.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");

const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
const existing = new Map(gold.items.map((i) => [i.id, i]));

// ---- 新增条目 ----

const NEW_ITEMS = [
  // ========== P0: 中国发病率前五的癌种 ==========
  {
    id: "Q54",
    department: "肿瘤",
    difficulty: "中",
    q: "原发性肺癌的驱动基因检测推荐哪些靶点",
    gtSources: ["原发性肺癌诊疗指南（2022年版）"],
    evidencePhrases: ["原发性肺癌", "驱动基因", "EGFR", "ALK", "ROS1"],
    expectGradeLabel: true,
    referenceAnswer:
      "原发性肺癌驱动基因检测推荐至少包括 EGFR、ALK、ROS1、BRAF V600E、RET、MET 等靶点，检测方法以 NGS 或 PCR 为主，组织样本优先，血浆 ctDNA 可作补充。",
    allowedClaims: ["EGFR", "ALK", "ROS1", "驱动基因"],
    forbiddenClaims: ["肺癌无需基因检测即可选择靶向治疗"],
    expectedRefusal: false,
  },
  {
    id: "Q55",
    department: "妇科",
    difficulty: "中",
    q: "卵巢癌的初始治疗方案如何选择",
    gtSources: ["卵巢癌诊疗指南（2022年版）"],
    evidencePhrases: ["卵巢癌", "初始治疗", "肿瘤细胞减灭术", "紫杉醇", "卡铂"],
    expectGradeLabel: true,
    referenceAnswer:
      "卵巢癌初始治疗以肿瘤细胞减灭术为核心，术后辅以铂类联合紫杉醇化疗（静脉/腹腔联合），BRCA突变者维持治疗可选PARP抑制剂，FIGO分期和残余灶大小决定辅助化疗方案与疗程。",
    allowedClaims: ["肿瘤细胞减灭术", "紫杉醇", "卡铂", "PARP抑制剂"],
    forbiddenClaims: ["卵巢癌无需手术仅化疗即可"],
    expectedRefusal: false,
  },
  {
    id: "Q56",
    department: "消化",
    difficulty: "中",
    q: "食管癌的筛查方法和内镜下治疗指征",
    gtSources: ["食管癌诊疗指南（2022年版）"],
    evidencePhrases: ["食管癌", "筛查", "内镜", "碘染色", "ESD"],
    expectGradeLabel: true,
    referenceAnswer:
      "食管癌筛查高危人群（40岁以上、食管癌高发区、有食管癌家族史等）推荐上消化道内镜检查联合碘染色及指示性活检。早期食管癌及癌前病变可行内镜下切除（ESD/EMR），进展期以手术+放化疗为主。",
    allowedClaims: ["碘染色", "内镜", "ESD", "高危人群"],
    forbiddenClaims: ["食管癌筛查仅靠症状即可"],
    expectedRefusal: false,
  },
  {
    id: "Q57",
    department: "肿瘤",
    difficulty: "中",
    q: "肾癌的病理分型及其对治疗选择的影响",
    gtSources: ["肾癌诊疗指南（2022年版）"],
    evidencePhrases: ["肾癌", "病理分型", "透明细胞", "TKI", "免疫治疗"],
    expectGradeLabel: true,
    referenceAnswer:
      "肾癌主要病理分型为透明细胞癌（约占75%）、乳头状肾细胞癌和嫌色细胞癌。透明细胞癌对TKI及免疫联合治疗敏感，晚期一线推荐TKI单药或免疫联合方案，非透明细胞癌疗效相对较差，以临床研究和个体化治疗为主。",
    allowedClaims: ["透明细胞", "TKI", "乳头状", "免疫治疗"],
    forbiddenClaims: ["所有肾癌亚型治疗方案相同"],
    expectedRefusal: false,
  },
  {
    id: "Q58",
    department: "肿瘤",
    difficulty: "中",
    q: "肌层浸润性膀胱癌的标准治疗方案",
    gtSources: ["膀胱癌诊疗指南（2022年版）"],
    evidencePhrases: ["膀胱癌", "肌层浸润", "根治性膀胱切除术", "新辅助化疗"],
    expectGradeLabel: true,
    referenceAnswer:
      "肌层浸润性膀胱癌的标准治疗为新辅助含顺铂方案化疗后行根治性膀胱切除术+盆腔淋巴结清扫，无法耐受者可选膀胱保留方案（TURBT+放化疗）。术后病理高危者辅助免疫治疗或化疗。",
    allowedClaims: ["根治性膀胱切除术", "新辅助化疗", "顺铂", "淋巴结清扫"],
    forbiddenClaims: ["肌层浸润性膀胱癌首选TURBT即可"],
    expectedRefusal: false,
  },

  // ========== P1: 高优先级 ==========
  {
    id: "Q59",
    department: "血液",
    difficulty: "高",
    q: "骨髓增生异常综合征伴原始细胞增多（MDS-EB）的治疗策略",
    gtSources: ["骨髓增生异常综合征伴原始细胞增多（MDS-EB）诊疗指南（2022年版）"],
    evidencePhrases: ["MDS-EB", "去甲基化药物", "阿扎胞苷", "造血干细胞移植"],
    expectGradeLabel: true,
    referenceAnswer:
      "MDS-EB（骨髓原始细胞5-19%）治疗以降甲基化药物（阿扎胞苷/地西他滨）为主，适合移植者尽早行异基因造血干细胞移植。去甲基化失败或进展者考虑临床试验或强化疗。支持治疗包括输血、G-CSF和抗感染。",
    allowedClaims: ["去甲基化药物", "阿扎胞苷", "造血干细胞移植"],
    forbiddenClaims: ["MDS-EB首选大剂量化疗即可治愈"],
    expectedRefusal: false,
  },
  {
    id: "Q60",
    department: "妇科",
    difficulty: "中",
    q: "子宫内膜癌的分子分型及其临床意义",
    gtSources: ["子宫内膜癌诊疗指南（2022年版）"],
    evidencePhrases: ["子宫内膜癌", "分子分型", "POLE", "MSI", "p53"],
    expectGradeLabel: true,
    referenceAnswer:
      "子宫内膜癌分子分型包括POLE超突变型（预后最好）、MSI-H型（免疫治疗敏感）、低拷贝数/NSMP型（预后中等）、高拷贝数/p53异常型（预后最差）。分子分型补充传统病理分型，指导手术范围及辅助治疗决策。",
    allowedClaims: ["POLE", "MSI", "p53", "分子分型"],
    forbiddenClaims: ["子宫内膜癌仅按病理分级即可决定治疗"],
    expectedRefusal: false,
  },
  {
    id: "Q61",
    department: "肿瘤",
    difficulty: "中",
    q: "HER2阳性乳腺癌的靶向治疗策略",
    gtSources: ["中国抗癌协会乳腺癌诊治指南与规范（2025年版）"],
    evidencePhrases: ["乳腺癌", "HER2阳性", "曲妥珠单抗", "帕妥珠单抗", "T-DXd"],
    expectGradeLabel: true,
    referenceAnswer:
      "HER2阳性乳腺癌靶向治疗以曲妥珠单抗为基础：早期辅助治疗推荐曲妥珠单抗+帕妥珠单抗联合化疗；晚期一线双靶（曲妥珠+帕妥珠）+紫杉类；二线可选T-DXd（德曲妥珠单抗）或T-DM1。",
    allowedClaims: ["曲妥珠单抗", "帕妥珠单抗", "T-DXd", "双靶"],
    forbiddenClaims: ["HER2阳性乳腺癌仅化疗即可不需靶向治疗"],
    expectedRefusal: false,
  },
  {
    id: "Q62",
    department: "内分泌",
    difficulty: "中",
    q: "老年糖尿病患者的血糖控制目标有何特殊性",
    gtSources: ["中国老年糖尿病诊疗指南（2024版）"],
    evidencePhrases: ["老年糖尿病", "血糖控制目标", "低血糖", "个体化"],
    expectGradeLabel: true,
    referenceAnswer:
      "老年糖尿病血糖控制目标需个体化：健康状况良好（无合并症）者HbA1c <7.5%；中等健康（合并1-2种慢性病）者<8.0%；健康状况差（多种合并症/认知障碍）者<8.5%。核心原则是避免低血糖，简化方案。",
    allowedClaims: ["7.5%", "8.0%", "8.5%", "个体化", "低血糖"],
    forbiddenClaims: ["老年糖尿病患者HbA1c一律控制在7%以下"],
    expectedRefusal: false,
  },
  {
    id: "Q63",
    department: "内分泌",
    difficulty: "中",
    q: "甲状腺结节的FNA穿刺指征和恶性风险评估",
    gtSources: ["甲状腺结节和分化型甲状腺癌诊治指南（第二版）"],
    evidencePhrases: ["甲状腺结节", "FNA", "TI-RADS", "恶性风险"],
    expectGradeLabel: true,
    referenceAnswer:
      "甲状腺结节FNA穿刺指征：TI-RADS 4类及以上且直径>1cm，或4类以上且直径0.5-1cm有高危因素（颈部放疗史、家族史、超声恶性特征）。TI-RADS 5类结节直径>0.5cm即建议穿刺。穿刺Bethesda分类决定后续手术或随访方案。",
    allowedClaims: ["FNA", "TI-RADS", "Bethesda"],
    forbiddenClaims: ["所有甲状腺结节均应常规FNA穿刺"],
    expectedRefusal: false,
  },
  {
    id: "Q64",
    department: "消化",
    difficulty: "中",
    q: "溃疡性结肠炎的阶梯治疗方案",
    gtSources: ["中国溃疡性结肠炎诊治指南（2023年·西安）"],
    evidencePhrases: ["溃疡性结肠炎", "阶梯治疗", "美沙拉嗪", "生物制剂", "JAK抑制剂"],
    expectGradeLabel: true,
    referenceAnswer:
      "溃疡性结肠炎阶梯治疗：轻中度活动期首选美沙拉嗪口服/灌肠，无效升级至布地奈德-MMX或全身激素；中重度活动期激素诱导后以免疫抑制剂或生物制剂（抗TNF-α/维多珠单抗/乌司奴单抗）维持；难治性可选JAK抑制剂（托法替布/乌帕替尼）。",
    allowedClaims: ["美沙拉嗪", "抗TNF-α", "维多珠单抗", "激素"],
    forbiddenClaims: ["溃疡性结肠炎初期即应用生物制剂"],
    expectedRefusal: false,
  },
  {
    id: "Q65",
    department: "消化",
    difficulty: "中",
    q: "克罗恩病的药物治疗选择与监测",
    gtSources: ["中国克罗恩病诊治指南（2023年·广州）"],
    evidencePhrases: ["克罗恩病", "药物治疗", "生物制剂", "粘膜愈合"],
    expectGradeLabel: true,
    referenceAnswer:
      "克罗恩病初始治疗：活动期给予激素或肠内营养诱导缓解，维持期推荐免疫抑制剂（硫唑嘌呤/甲氨蝶呤）或生物制剂（抗TNF-α/乌司奴单抗/维得利珠单抗），治疗目标为临床缓解+粘膜愈合，定期监测药物浓度与抗抗体。",
    allowedClaims: ["肠内营养", "硫唑嘌呤", "抗TNF-α", "乌司奴单抗", "粘膜愈合"],
    forbiddenClaims: ["克罗恩病激素长期维持即可"],
    expectedRefusal: false,
  },
];

// ---- 合并写入 ----
let added = 0;
for (const item of NEW_ITEMS) {
  if (existing.has(item.id)) {
    console.warn(`[skip] ${item.id} 已存在，跳过`);
    continue;
  }
  existing.set(item.id, item);
  added++;
}

// 按 ID 排序（Q01, Q02, ..., Q65）
const sorted = [...existing.values()].sort((a, b) => {
  const na = parseInt(a.id.slice(1), 10);
  const nb = parseInt(b.id.slice(1), 10);
  return na - nb;
});

gold.items = sorted;
writeFileSync(GOLD_PATH, JSON.stringify(gold, null, 2), "utf-8");

console.log(`✅ 注入完成：新增 ${added} 题，现有总数 ${sorted.length} 题`);
console.log("新增题目:");
for (const item of NEW_ITEMS) {
  if (existing.has(item.id)) {
    console.log(`  ${item.id} [${item.department}] ${item.q.slice(0, 40)}...`);
  }
}
