// classify-source.mjs
// LLM 辅助专科分类 —— 用 sensenova 免费模型对来源名做零样本分类。
//
// 用法：
//   node scripts/kb/classify/classify-source.mjs <sourceId>         单一来源分类
//   node scripts/kb/classify/classify-source.mjs --batch           全库未分类来源批量分类
//   node scripts/kb/classify/classify-source.mjs --all             全库来源批量重分类（覆盖已有）
//
// 设计原则：
// - 纯项目层扩展，不碰 pi-knowledge 内核
// - 使用项目已有的 callLLM 工具（免费优先 sensenova-6.7-flash-lite）
// - 分类结果写入 kb-sources.json 的 department 字段
// - 不替代 inferDepartment 正则分类，仅辅助补充

import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB_MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const LLM_MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/llm-judge/client.mjs")).href;

const kb = await import(KB_MOD);
const { callLLM, isLLMAvailable } = await import(LLM_MOD);

/** 16 个目标专科（与 inferDepartment 一致）。 */
const DEPARTMENTS = [
  "肿瘤", "血液", "呼吸/感染", "外科/综合", "慢病/代谢",
  "儿科", "急诊", "产科", "心血管", "神经",
  "消化", "肾内", "内分泌", "风湿免疫", "精神", "其他内科",
];

/** 每科的典型疾病/关键词，供 LLM 参考。 */
const DEPT_HINTS = {
  "肿瘤": "癌、瘤、淋巴瘤、白血病、骨髓瘤、黑色素瘤",
  "血液": "溶血、血友病、骨髓增生异常、凝血",
  "呼吸/感染": "肺炎、流感、结核、支原体、呼吸道感染",
  "外科/综合": "骨折、创伤、普外科、骨科、中医药、转诊",
  "慢病/代谢": "肥胖、代谢综合征、慢病管理",
  "儿科": "儿童、小儿、婴幼儿、新生儿",
  "急诊": "急诊、急救、复苏、中毒、危重症",
  "产科": "妊娠、分娩、孕产妇、产后、围产",
  "心血管": "冠心病、高血压、心衰、心律失常、心房颤动",
  "神经": "卒中、脑梗、癫痫、帕金森、痴呆、脑血管",
  "消化": "肝病、胃病、肠病、胰腺、消化内镜",
  "肾内": "肾病、透析、肾衰竭、慢性肾脏病",
  "内分泌": "糖尿病、甲状腺、骨质疏松、痛风、内分泌",
  "风湿免疫": "风湿、类风湿、狼疮、关节炎、免疫",
  "精神": "抑郁、焦虑、精神分裂、睡眠障碍",
};

async function classifySourceName(sourceName) {
  const system = `你是一位医疗知识库管理员。请根据指南名称判断其所属专科。

可选专科（必须严格从以下列表中选择一个，且只输出专科名称，不要其他文字）：
${DEPARTMENTS.join("、")}

各科典型关键词：
${Object.entries(DEPT_HINTS)
  .map(([dept, keywords]) => `${dept}：${keywords}`)
  .join("\n")}

如果指南名称明显不属任何专科（如行政文件、名单、管理办法），请输出"其他内科"。`;

  const result = await callLLM([
    { role: "system", content: system },
    { role: "user", content: `请分类这份指南：\n${sourceName}` },
  ], { temperature: 0.1, max_tokens: 32 });

  const text = (result || "").trim();
  // 从 LLM 回复中提取专科名
  for (const d of DEPARTMENTS) {
    if (text.includes(d)) return d;
  }
  return "其他内科";
}

async function main() {
  const [target, flag] = process.argv.slice(2);

  if (!(await isLLMAvailable())) {
    console.error("LLM 不可用（无免费 API Key），请设置 SENSENOVA_API_KEYS 或 SENSENOVA_API_KEY");
    process.exit(1);
  }

  if (target === "--batch" || target === "--all") {
    const force = target === "--all";
    const registry = kb.loadRegistry();
    let candidates = registry.sources;

    if (!force) {
      // --batch: 仅处理 department 为空的来源（使用 inferDepartment 的默认值也算已有）
      candidates = registry.sources.filter(
        (s) => !s.department || s.department === "其他内科" || s.department === ""
      );
    }

    console.log(`LLM 批量分类: ${candidates.length}/${registry.sources.length} 个来源${force ? "（全部强制重分类）" : "（仅未分类/其他内科）"}\n`);

    let ok = 0, fail = 0;
    for (const s of candidates) {
      try {
        const dept = await classifySourceName(s.name);
        const prev = s.department || "(空)";
        s.department = dept;
        kb.saveRegistry(registry);
        const changed = prev !== dept ? "←变更" : "";
        console.log(`  [${s.id}] ${prev} → ${dept} ${changed}`);
        ok++;
      } catch (err) {
        console.error(`  ✗ [${s.id}] 分类失败: ${err instanceof Error ? err.message : err}`);
        fail++;
      }
    }
    console.log(`\n完成: ${ok} 成功, ${fail} 失败`);
    process.exit(fail > 0 ? 1 : 0);
  }

  if (target) {
    const registry = kb.loadRegistry();
    const entry = registry.sources.find((s) => s.id === target);
    if (!entry) {
      console.error(`来源未找到: "${target}"`);
      process.exit(1);
    }
    console.log(`正在分类: [${entry.id}] ${entry.name}`);
    console.log(`当前专科: ${entry.department || "(空)"}`);
    const dept = await classifySourceName(entry.name);
    entry.department = dept;
    kb.saveRegistry(registry);
    console.log(`分类结果: ${dept}`);
    process.exit(0);
  }

  // 无参数：打印帮助
  console.log(`LLM 辅助专科分类

用法: node scripts/kb/classify/classify-source.mjs <sourceId>
      node scripts/kb/classify/classify-source.mjs --batch
      node scripts/kb/classify/classify-source.mjs --all

参数:
  <sourceId>    对指定来源分类（用于单条测试/补录）
  --batch       批量分类未设定专科或归类"其他内科"的来源
  --all         全库来源强制重分类（覆盖已有 department）

前提: 需设置 SENSENOVA_API_KEYS 或 SENSENOVA_API_KEY 环境变量`);
}

main().catch((err) => {
  console.error("[classify] 失败:", err);
  process.exit(1);
});
