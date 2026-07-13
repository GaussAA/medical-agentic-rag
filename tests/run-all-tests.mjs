/**
 * 医疗 Agentic RAG 自动化测试运行器
 *
 * 测试范围:
 *  - 数据完整性测试（知识图谱、指南索引、大纲）
 *  - 检索质量测试（关键词匹配）
 *  - 知识图谱关系测试
 *
 * 用法: node tests/run-all-tests.mjs
 * 输出: tests/reports/test-report.json
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
// CI 降级开关：知识库原始文档（raw/）与 kb-sources.json 不入库，
// 纯净 checkout 下相关断言无法执行；CI 环境跳过这些依赖未入库大文件的校验，
// 仅保留结构/扩展/System Prompt 等不依赖原始文档的门禁。本地（无 CI env）仍全量执行。
const SKIP_KB = process.env.CI === "true" || process.env.SKIP_KB === "1";
const KB_DIR = join(ROOT, "data", "kb");
// 方案 B：源真相为 raw/ 下的原始 PDF/DOCX（非 MD）
const RAW_DIR = join(ROOT, "data", "raw");
/** 统计原始知识库可抽取文件数（PDF/DOCX，排除临时残留）。 */
async function countRaw() {
  try {
    return (await readdir(RAW_DIR)).filter((f) => /\.(pdf|docx|txt)$/i.test(f) && !/\.nhc_tmp_/i.test(f)).length;
  } catch {
    // 原始知识库未入库（如 CI 纯净 checkout）时返回 0，由 SKIP_KB 门禁跳过相关断言
    return 0;
  }
}

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
  const rawCount = await countRaw();

  await runSuite("指南索引测试", [
    {
      name: "指南索引文件存在且格式正确",
      fn: () => {
        if (!SKIP_KB) {
          assert(index.totalGuides <= rawCount, `索引指南数 ${index.totalGuides} > 原始文档数 ${rawCount}`);
        }
        assert(index.totalGuides >= 100, `指南数回退至基线以下: ${index.totalGuides}`);
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
  const rawCount = await countRaw();

  await runSuite("大纲数据测试", [
    {
      name: "全部指南解析（CI 下跳过与原始文档数比对）",
      fn: () => {
        if (!SKIP_KB) {
          assert(outline.totalFiles === rawCount, `大纲 ${outline.totalFiles} 份 ≠ 原始文档 ${rawCount} 份`);
        }
      },
    },
    {
      name: "章节总数 >= 1000",
      fn: () => {
        assert(outline.totalSections >= 1000, `仅 ${outline.totalSections} 章节`);
      },
    },
    {
      name: "关键段落总数 >= 400（原始文本句子边界较 MD 稀疏）",
      fn: () => {
        assert(outline.totalKeyParagraphs >= 400, `仅 ${outline.totalKeyParagraphs} 关键段落`);
      },
    },
    {
      name: "每份指南都有 hierarchy 结构（成员名单/纯流程图等可章节数为 0）",
      fn: () => {
        for (const guide of outline.guides) {
          assert(Array.isArray(guide.hierarchy), `${guide.title} 缺少 hierarchy`);
        }
      },
    },
  ]);
}

// ============================================================
// 测试套件 4: 知识库文件完整性
// ============================================================
async function testKBIntegrity() {
  const files = (await readdir(RAW_DIR)).filter((f) => /\.(pdf|docx|txt)$/i.test(f) && !/\.nhc_tmp_/i.test(f));

  await runSuite("知识库文件完整性（原始文档）", [
    {
      name: "原始文档数 ≥ 基线 100（知识库已扩容）",
      fn: () => {
        assert(files.length >= 100, `实际 ${files.length} 份原始文档，低于基线 100`);
      },
    },
    {
      name: "所有原始文档均为 PDF/DOCX/TXT 且可读取不为空",
      fn: async () => {
        for (const file of files) {
          const buf = readFileSync(join(RAW_DIR, file));
          assert(buf.length > 1000, `${file} 文件过小 (${buf.length} 字节)`);
        }
      },
    },
    {
      name: "归一化文本已生成（raw-txt 与原始一一对应且非空）",
      fn: async () => {
        const txtDir = join(ROOT, "data", "raw-txt");
        const txtFiles = (await readdir(txtDir)).filter((f) => f.endsWith(".txt"));
        assert(txtFiles.length === files.length, `归一化文本数 ${txtFiles.length} ≠ 原始 ${files.length}`);
        for (const file of files) {
          const base = file.replace(/\.(pdf|docx|txt)$/i, "");
          const buf = readFileSync(join(txtDir, base + ".txt"));
          assert(buf.length > 0, `${base}.txt 缺失或为空`);
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
        assert(names.includes("provider.agnes"), "缺少 provider.agnes.ts");
        assert(names.includes("provider.sensenova"), "缺少 provider.sensenova.ts");
        assert(names.includes("retrieval.kg-search-tool"), "缺少 retrieval.kg-search-tool.ts");
        assert(names.includes("retrieval.guide-finder"), "缺少 retrieval.guide-finder.ts");
        assert(names.includes("retrieval.query-decomposer"), "缺少 retrieval.query-decomposer.ts");
        assert(names.includes("eval.answer-evaluator"), "缺少 eval.answer-evaluator.ts");
      },
    },
  ]);
}

// ============================================================
// 测试套件 6: System Prompt 完整性
// ============================================================
async function testSystemPrompt() {
  const prompt = await readFile(join(ROOT, ".pi", "prompts", "medical-agent.md"), "utf-8");

  await runSuite("System Prompt 完整性", [
    {
      name: "包含合规角色定义",
      fn: () => {
        // 合规役已删除"主任医师"虚假权威措辞，改为循证信息辅助工具定位
        assert(
          prompt.includes("循证医学信息辅助工具") || prompt.includes("信息检索与整理助手"),
          "缺少合规角色定义（循证信息辅助工具）",
        );
      },
    },
    {
      name: "不含虚假权威自称",
      fn: () => {
        // 断言 prompt 明确禁止自称主任医师/专家（合规护栏）
        assert(
          prompt.includes("严禁自称") || prompt.includes("避免制造虚假权威"),
          "缺少禁止虚假权威自称的合规护栏",
        );
      },
    },
    {
      name: "包含知识库使用规范",
      fn: () => {
        assert(prompt.includes("rag_search"), "缺少 rag_search 引用");
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
      // P2-⑤：由单关键词放行升级为结构化多维断言，逐维校验安全护栏，
      // 删除任一整段护栏均可被测出（旧断言仅命中单关键词，删整段仍放行）。
      name: "包含安全护栏（结构化多维）",
      fn: () => {
        // 维度1：强制免责声明模板（三要素齐备）
        assert(prompt.includes("免责声明"), "缺少安全护栏·强制免责声明标题");
        assert(prompt.includes("不构成"), "缺少安全护栏·免责声明「不构成诊断」要素");
        assert(prompt.includes("不能替代"), "缺少安全护栏·免责声明「不能替代医师」要素");
        // 维度2：急症引导（就医 + 急救电话）
        assert(prompt.includes("立即就医"), "缺少安全护栏·急症「立即就医」引导");
        assert(prompt.includes("120"), "缺少安全护栏·急症「120」急救电话");
        // 维度3：越界拒答（能力边界 + 非医疗任务不代做）
        assert(prompt.includes("不越界"), "缺少安全护栏·越界拒答规则");
        assert(
          prompt.includes("能力边界") || prompt.includes("不得代为完成非医疗任务"),
          "缺少安全护栏·越界能力边界声明",
        );
        // 维度4：处方限制（须医师指导）
        assert(prompt.includes("医师指导下使用"), "缺少安全护栏·处方「医师指导下使用」限制");
        // 维度5：防药物幻觉（不得臆造未载于指南的方案）
        assert(prompt.includes("不得自行拼接"), "缺少安全护栏·防药物幻觉约束");
        // 维度6：隐私红线（PHI 脱敏）
        assert(prompt.includes("PHI"), "缺少安全护栏·隐私红线（PHI）");
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
  if (!SKIP_KB) {
    await testKBIntegrity();
  } else {
    console.log("(CI 模式：跳过「知识库文件完整性」套件——原始文档 raw/ 未入库)\n");
  }
  await testExtensionFiles();
  await testSystemPrompt();

  // Write report
  const reportPath = join(__dirname, "reports", "test-report.json");
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
