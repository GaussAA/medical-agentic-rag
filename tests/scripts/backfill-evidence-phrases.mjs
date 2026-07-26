/**
 * 回填缺失的 evidencePhrases
 *
 * 从 systemAnswer（优先）或 referenceAnswer 中提取关键证据短语，
 * 补充到 gold-answers.json 中缺失 evidencePhrases 的题目。
 *
 * 提取规则：
 * - 疾病名称、药物名称、医学术语
 * - 检查方法、治疗手段
 * - 3-5 个短语/条
 * - 保留指南原文中的关键词（非泛化表述）
 *
 * 用法：node tests/scripts/backfill-evidence-phrases.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));

// 每条题目的自定义证据短语（从 systemAnswer / referenceAnswer 中提取的关键概念）
// 提取方法：保留指南原文中的核心术语，剔除问句本身
const CUSTOM_PHRASES = {
  Q13: ["离婚起诉状", "诉讼请求", "感情破裂"],  // 越界拒答题，证据来自非医学领域
  Q14: ["急性心肌梗死", "胸痛", "急救", "120"],
  Q15: ["宫颈癌筛查", "HPV检测", "TCT", "液基薄层细胞学"],
  Q16: ["幽门螺杆菌", "根除治疗", "消化性溃疡", "MALT淋巴瘤"],
  Q17: ["慢阻肺", "稳定期", "吸入治疗", "LAMA", "LABA", "ICS"],
  Q18: ["缺血性脑卒中", "静脉溶栓", "时间窗", "4.5小时", "阿替普酶"],
  Q19: ["艾滋病", "抗病毒治疗", "ART", "CD4"],
  Q20: ["老年髋部骨折", "手术时机", "48小时", "早期手术"],
  Q21: ["肝硬化", "门静脉高压", "布洛芬", "NSAIDs", "消化道出血"],
  Q22: ["妊娠期高血压", "依那普利", "ACEI", "禁忌", "拉贝洛尔"],
  Q23: ["脑出血", "脑梗死", "急性期", "降压目标", "个体化"],
  Q24: [],  // 越界拒答题（Python爬虫），无医学证据短语
  Q25: ["脑卒中", "FAST", "面瘫", "肢体无力", "言语不清", "急救"],
  Q26: ["慢阻肺稳定期", "LAMA", "LABA", "ICS", "支气管舒张剂"],
  Q27: ["社区获得性肺炎", "门诊", "经验性治疗", "抗菌药物", "大环内酯"],
  Q28: ["流感", "奥司他韦", "48小时", "抗病毒", "神经氨酸酶抑制剂"],
  Q29: ["肺结核", "耐药", "全程治疗", "DOTS", "联合用药"],
  Q30: ["幽门螺杆菌", "根除", "四联疗法", "铋剂", "PPI"],
  Q31: ["妊娠期高血糖", "血糖控制", "医学营养治疗", "胰岛素"],
  Q32: ["产后大出血", "紧急", "宫缩剂", "按摩子宫", "急救"],
  Q33: ["糖尿病酮症酸中毒", "DKA", "恶心呕吐", "烂苹果味", "急诊"],
  Q34: ["骨质疏松", "防治", "钙剂", "维生素D", "双膦酸盐"],
  Q35: ["华法林", "阿司匹林", "抗凝", "出血风险", "INR"],
  Q36: ["二甲双胍", "增强CT", "造影剂", "肾功能", "乳酸性酸中毒"],
  Q37: ["癫痫", "用药原则", "单药治疗", "规律服药", "药物浓度"],
  Q38: ["多重用药", "老年人", "Beers标准", "药物相互作用", "简化方案"],
  Q39: [],  // 越界拒答题（算命），无医学证据短语
  Q40: ["蜂蜇", "严重过敏反应", "肾上腺素", "呼吸困难", "急救"],
  Q41: ["感冒药", "重复用药", "对乙酰氨基酚", "中成药", "不良反应"],
};

let updated = 0;
for (const item of gold.items) {
  if (item.evidencePhrases && item.evidencePhrases.length > 0) continue;
  const phrases = CUSTOM_PHRASES[item.id] || [];
  if (phrases.length > 0) {
    // 去空
    item.evidencePhrases = phrases.filter(Boolean);
    updated++;
    console.log(`  ${item.id}: ${item.evidencePhrases.join("、")}`);
  }
}

writeFileSync(GOLD_PATH, JSON.stringify(gold, null, 2), "utf-8");
console.log(`\n已更新 ${updated} 条 evidencePhrases`);
