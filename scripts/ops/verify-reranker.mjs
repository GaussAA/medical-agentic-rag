/**
 * 中文重排序模型验证脚本（raw logits 版）
 *
 * bge-reranker-base 用 rank loss 训练，logits 普遍偏大，
 * 经 transformers.js text-classification 的 sigmoid 后饱和到 1.0，无区分度。
 * 正确做法：取 model 原始 logits 排序。
 *
 * 本脚本用 AutoModelForSequenceClassification + AutoTokenizer 直接取 logits，
 * 验证中文医疗场景下相关/无关 passage 的 logits 区分度。
 *
 * 用法: node scripts/ops/verify-reranker.mjs
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const PI_NODE_MODULES = join(homedir(), ".pi", "agent", "npm", "node_modules");
const require = createRequire(join(PI_NODE_MODULES, "_"));
const { AutoTokenizer, AutoModelForSequenceClassification, env } = require("@huggingface/transformers");

env.cacheDir = join(homedir(), ".pi", "knowledge", "models");

const MODEL = "Xenova/bge-reranker-base";

const TEST_CASES = [
  {
    query: "原发性肝癌的高危人群有哪些？",
    passages: [
      { text: "肝癌高危人群包括HBV/HCV感染、过度饮酒、肝脂肪变性、肝硬化及肝癌家族史。", expect: "high" },
      { text: "儿童肺炎支原体肺炎首选大环内酯类抗生素如阿奇霉素。", expect: "low" },
      { text: "肥胖症的诊断标准为BMI≥28kg/m²。", expect: "low" },
    ],
  },
  {
    query: "儿童支原体肺炎的推荐用药是什么？",
    passages: [
      { text: "儿童肺炎支原体肺炎首选大环内酯类抗菌药物，首选阿奇霉素。", expect: "high" },
      { text: "原发性肝癌治疗以手术切除、肝移植和局部消融为主。", expect: "low" },
      { text: "黑色素瘤早期识别采用ABCDE法则。", expect: "low" },
    ],
  },
  {
    query: "肥胖症的诊断标准",
    passages: [
      { text: "肥胖症的诊断标准为BMI≥28kg/m²，可伴有腰围超标及代谢异常。", expect: "high" },
      { text: "流行性感冒推荐使用奥司他韦等神经氨酸酶抑制剂。", expect: "low" },
      { text: "血友病A的替代治疗首选重组FVIII制剂。", expect: "low" },
    ],
  },
];

async function main() {
  console.log(`加载模型: ${MODEL} (取 raw logits)\n`);
  const tokenizer = await AutoTokenizer.from_pretrained(MODEL);
  const model = await AutoModelForSequenceClassification.from_pretrained(MODEL);

  let pass = 0;

  for (const tc of TEST_CASES) {
    console.log(`Query: ${tc.query}`);
    const shuffled = [...tc.passages].sort(() => Math.random() - 0.5);
    const scored = [];
    for (const p of shuffled) {
      const inputs = tokenizer(tc.query, { text_pair: p.text, padding: true, truncation: true });
      const { logits } = await model(inputs);
      scored.push({ text: p.text, logit: logits.data[0], expect: p.expect });
    }
    scored.sort((a, b) => b.logit - a.logit);

    const topIsHigh = scored[0].expect === "high";
    if (topIsHigh) pass++;

    for (const s of scored) {
      const tag = s.expect === "high" ? "[相关]" : "[无关]";
      const flag = s.expect === "high" ? (s === scored[0] ? " OK " : "FAIL") : "    ";
      console.log(`  ${flag} ${tag} logit=${s.logit.toFixed(4).padStart(8)}  ${s.text.slice(0, 42)}`);
    }
    console.log("");
  }

  console.log("=".repeat(50));
  console.log(`用例通过率: ${pass}/${TEST_CASES.length} (相关文档须置顶, 打乱顺序)`);
  console.log("=".repeat(50));

  process.exit(pass === TEST_CASES.length ? 0 : 1);
}

main().catch((err) => {
  console.error("验证异常:", err);
  process.exit(1);
});
