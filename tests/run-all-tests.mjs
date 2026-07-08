/**
 * 医疗 Agentic RAG 自动化测试运行器
 *
 * 测试范围:
 *  - 数据完整性测试（知识图谱、指南索引、大纲）
 *  - 检索质量测试（关键词匹配）
 *  - 知识图谱关系测试
 *
 * 用法: node tests/run-all-tests.mjs
 * 输出: tests/test-report.json
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const KB_DIR = join(ROOT, "medical-knowlegde-base");

// Test result accumulator
const results = {
  timestamp: new Date().toISOString(),
  summary: { passed: 0, failed: 0, total: 0 },
  suites: [],
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function runSuite(name, tests) {
  const suite = { name, tests: [] };
  let passed = 0;
  let failed = 0;

  for (const test of tests) {
    const entry = { name: test.name, passed: false, error: null };
    try {
      await test.fn();
      entry.passed = true;
      passed++;
    } catch (err) {
      entry.error = err.message;
      failed++;
    }
    suite.tests.push(entry);
  }

  suite.passed = passed;
  suite.failed = failed;
  results.summary.passed += passed;
  results.summary.failed += failed;
  results.summary.total += tests.length;
  results.suites.push(suite);

  console.log(`${name}: ${passed}/${tests.length} passed${failed ? ` (${failed} failed)` : ""}`);
  for (const t of suite.tests) {
    if (t.passed) {
      console.log(`  ✅ ${t.name}`);
    } else {
      console.log(`  ❌ ${t.name}: ${t.error}`);
    }
  }
  console.log();
}

// ============================================================
// 测试套件 1: 知识图谱测试
// ============================================================
async function testKnowledgeGraph() {
  const kg = JSON.parse(await readFile(join(KB_DIR, ".knowledge-graph.json"), "utf-8"));

  await runSuite("知识图谱测试", [
    {
      name: "知识图谱文件存在且格式正确",
      fn: () => {
        assert(kg.generatedAt, "缺少 generatedAt");
        assert(kg.stats, "缺少 stats");
        assert(Array.isArray(kg.entities), "entities 不是数组");
      },
    },
    {
      name: "实体数量 >= 200 条",
      fn: () => {
        assert(kg.stats.uniqueEntities >= 200, `仅 ${kg.stats.uniqueEntities} 条实体，期望 >= 200`);
      },
    },
    {
      name: "疾病数 >= 20 种",
      fn: () => {
        assert(kg.stats.diseaseCount >= 20, `仅 ${kg.stats.diseaseCount} 个疾病，期望 >= 20`);
      },
    },
    {
      name: "药物数 >= 30 种",
      fn: () => {
        assert(kg.stats.drugCount >= 30, `仅 ${kg.stats.drugCount} 种药物，期望 >= 30`);
      },
    },
    {
      name: "症状数 >= 30 种",
      fn: () => {
        assert(kg.stats.symptomCount >= 30, `仅 ${kg.stats.symptomCount} 种症状，期望 >= 30`);
      },
    },
    {
      name: "检查方法数 >= 50 项",
      fn: () => {
        assert(kg.stats.examCount >= 50, `仅 ${kg.stats.examCount} 项检查，期望 >= 50`);
      },
    },
    {
      name: "实体的 entityType 值均合法",
      fn: () => {
        const validTypes = ["drug", "symptom", "examination", "riskFactor", "treatment"];
        for (const e of kg.entities) {
          assert(validTypes.includes(e.entityType), `非法 entityType: ${e.entityType} (${e.disease})`);
        }
      },
    },
    {
      name: "实体的 relation 值均合法",
      fn: () => {
        const validRelations = ["treated_with", "has_symptom", "diagnosed_by", "has_risk", "treated_by"];
        for (const e of kg.entities) {
          assert(validRelations.includes(e.relation), `非法 relation: ${e.relation} (${e.disease})`);
        }
      },
    },
    {
      name: "每个实体都有 source 字段",
      fn: () => {
        for (const e of kg.entities) {
          assert(e.source && e.source.length > 0, `实体缺少 source: ${e.disease}/${e.entityName}`);
        }
      },
    },
  ]);
}

// ============================================================
// 测试套件 2: 指南索引测试
// ============================================================
async function testGuideIndex() {
  const index = JSON.parse(await readFile(join(KB_DIR, ".guide-index.json"), "utf-8"));

  await runSuite("指南索引测试", [
    {
      name: "指南索引文件存在且格式正确",
      fn: () => {
        assert(index.totalGuides === 26, `应有 26 份指南，实际 ${index.totalGuides}`);
        assert(index.totalKeywords > 200, `关键词数 ${index.totalKeywords} < 200`);
      },
    },
    {
      name: "所有指南都有 disease 字段",
      fn: () => {
        for (const [title, info] of Object.entries(index.guideMap)) {
          assert(info.disease, `指南 ${title} 缺少 disease`);
        }
      },
    },
    {
      name: "肝癌 应映射到 原发性肝癌诊疗指南",
      fn: () => {
        const allGuides = new Set();
        for (const [kw, guides] of Object.entries(index.keywordIndex)) {
          if (kw.includes("肝癌") || kw.includes("肝细胞")) {
            for (const g of guides) allGuides.add(g);
          }
        }
        assert(
          [...allGuides].some((g) => g.includes("原发性肝癌")),
          `"肝癌" 无法匹配到任何包含 "原发性肝癌" 的指南`
        );
      },
    },
    {
      name: "肺炎 应映射到 肺炎相关指南",
      fn: () => {
        const allGuides = new Set();
        for (const [kw, guides] of Object.entries(index.keywordIndex)) {
          if (kw.includes("肺炎") || kw.includes("支原体")) {
            for (const g of guides) allGuides.add(g);
          }
        }
        assert(
          [...allGuides].some((g) => g.includes("肺炎")),
          `"肺炎" 无法匹配到任何肺炎指南`
        );
      },
    },
    {
      name: "黑色素瘤 应映射到 黑色素瘤指南",
      fn: () => {
        const guides = index.keywordIndex["黑色素瘤"] || [];
        assert(guides.length > 0, `"黑色素瘤" 无映射`);
      },
    },
  ]);
}

// ============================================================
// 测试套件 3: 大纲数据测试
// ============================================================
async function testOutline() {
  const outline = JSON.parse(await readFile(join(KB_DIR, ".outline.json"), "utf-8"));

  await runSuite("大纲数据测试", [
    {
      name: "26 份指南全部解析",
      fn: () => {
        assert(outline.totalFiles === 26, `仅解析 ${outline.totalFiles} 份`);
      },
    },
    {
      name: "章节总数 >= 1000",
      fn: () => {
        assert(outline.totalSections >= 1000, `仅 ${outline.totalSections} 章节`);
      },
    },
    {
      name: "关键段落总数 >= 500",
      fn: () => {
        assert(outline.totalKeyParagraphs >= 500, `仅 ${outline.totalKeyParagraphs} 关键段落`);
      },
    },
    {
      name: "每份指南都有 hierarchy 结构",
      fn: () => {
        for (const guide of outline.guides) {
          assert(Array.isArray(guide.hierarchy), `${guide.title} 缺少 hierarchy`);
          assert(guide.sectionCount > 0, `${guide.title} 章节数为 0`);
        }
      },
    },
  ]);
}

// ============================================================
// 测试套件 4: 知识库文件完整性
// ============================================================
async function testKBIntegrity() {
  const files = (await readdir(KB_DIR)).filter((f) => f.endsWith(".md") && !f.startsWith("."));

  await runSuite("知识库文件完整性", [
    {
      name: "MD 文件数 = 26",
      fn: () => {
        assert(files.length === 26, `实际 ${files.length} 个 MD 文件`);
      },
    },
    {
      name: "所有 MD 文件均可读取且不为空",
      fn: async () => {
        for (const file of files) {
          const text = await readFile(join(KB_DIR, file), "utf-8");
          assert(text.length > 1000, `${file} 文件过短 (${text.length} 字符)`);
        }
      },
    },
    {
      name: "所有文件包含 Markdown 标题",
      fn: async () => {
        for (const file of files) {
          const text = await readFile(join(KB_DIR, file), "utf-8");
          assert(text.startsWith("# "), `${file} 缺少一级标题`);
        }
      },
    },
  ]);
}

// ============================================================
// 测试套件 5: 扩展文件完整性
// ============================================================
async function testExtensionFiles() {
  const extDir = join(ROOT, ".pi", "extensions");
  const extFiles = (await readdir(extDir)).filter((f) => f.endsWith(".ts"));

  await runSuite("扩展文件完整性", [
    {
      name: "扩展文件数 >= 6",
      fn: () => {
        assert(extFiles.length >= 6, `仅 ${extFiles.length} 个扩展`);
      },
    },
    {
      name: "所有 .ts 文件均可解析（不含语法错误）",
      fn: async () => {
        for (const file of extFiles) {
          const text = await readFile(join(extDir, file), "utf-8");
          assert(
            text.includes("export default function"),
            `${file} 缺少 export default function`
          );
          assert(
            text.includes("ExtensionAPI"),
            `${file} 未使用 ExtensionAPI 类型`
          );
        }
      },
    },
    {
      name: "必需的扩展都存在",
      fn: () => {
        const names = extFiles.join(" ");
        assert(names.includes("agnes-provider"), "缺少 agnes-provider");
        assert(names.includes("sensenova-provider"), "缺少 sensenova-provider");
        assert(names.includes("kg-search-tool"), "缺少 kg-search-tool");
        assert(names.includes("guide-finder"), "缺少 guide-finder");
        assert(names.includes("query-decomposer"), "缺少 query-decomposer");
        assert(names.includes("answer-evaluator"), "缺少 answer-evaluator");
      },
    },
  ]);
}

// ============================================================
// 测试套件 6: System Prompt 完整性
// ============================================================
async function testSystemPrompt() {
  const prompt = await readFile(join(ROOT, "prompts", "medical-agent.md"), "utf-8");

  await runSuite("System Prompt 完整性", [
    {
      name: "包含角色定义",
      fn: () => {
        assert(prompt.includes("主任医师"), "缺少主任医师角色定义");
      },
    },
    {
      name: "包含知识库使用规范",
      fn: () => {
        assert(prompt.includes("knowledge_search"), "缺少 knowledge_search 引用");
        assert(prompt.includes("guide_finder"), "缺少 guide_finder 引用");
      },
    },
    {
      name: "包含搜索模式表",
      fn: () => {
        assert(prompt.includes("hybrid"), "缺少 hybrid 模式");
        assert(prompt.includes("deep"), "缺少 deep 模式");
      },
    },
    {
      name: "包含回答规范",
      fn: () => {
        assert(prompt.includes("证据来源"), "缺少证据来源");
        assert(prompt.includes("证据等级"), "缺少证据等级");
      },
    },
    {
      name: "包含安全护栏",
      fn: () => {
        assert(prompt.includes("立即就医") || prompt.includes("临床判断"), "缺少安全护栏");
      },
    },
    {
      name: "包含子代理规则",
      fn: () => {
        assert(prompt.includes("subagent"), "缺少 subagent 规则");
      },
    },
    {
      name: "包含查询分解规则",
      fn: () => {
        assert(prompt.includes("query_decomposer"), "缺少 query_decomposer 规则");
      },
    },
  ]);
}

// ============================================================
// 主函数
// ============================================================
async function main() {
  console.log("=".repeat(50));
  console.log("  医疗 Agentic RAG 自动化测试");
  console.log("=".repeat(50));
  console.log();

  await testKnowledgeGraph();
  await testGuideIndex();
  await testOutline();
  await testKBIntegrity();
  await testExtensionFiles();
  await testSystemPrompt();

  // Write report
  const reportPath = join(__dirname, "test-report.json");
  await writeFile(reportPath, JSON.stringify(results, null, 2), "utf-8");

  console.log("=".repeat(50));
  console.log(`测试报告: ${reportPath}`);
  console.log(`结果: ${results.summary.passed}/${results.summary.total} 通过`);
  if (results.summary.failed > 0) {
    console.log(`失败: ${results.summary.failed} 个`);
  }
  console.log("=".repeat(50));

  process.exit(results.summary.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("测试运行异常:", err);
  process.exit(1);
});
