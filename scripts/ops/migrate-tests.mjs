// scripts/ops/migrate-tests.mjs
// 测试文件重组迁移脚本 —— git mv + import 路径修复
// 运行: node scripts/ops/migrate-tests.mjs
// 参数: --dry-run 演练模式（不实际执行）

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dryRun = process.argv.includes("--dry-run");
const ROOT = process.cwd();

// 映射表: [旧路径(相对tests/unit/), 新路径(相对tests/)]
// 注意：新路径已包含完整 tests/ 下的子目录
const MAPPING = [
  // ─── extensions/ ──────────────────────
  // provider
  ["provider-registration-test.mjs",   "unit/extensions/provider/registration.test.mjs"],
  // retrieval
  ["query-decomposer-test.mjs",        "unit/extensions/retrieval/query-decomposer.test.mjs"],
  ["medical-infographic-test.mjs",     "unit/extensions/retrieval/medical-infographic.test.mjs"],
  // safety
  ["scope-guard-test.mjs",             "unit/extensions/safety/scope-guard.test.mjs"],
  ["faithfulness-guard-test.mjs",      "unit/extensions/safety/faithfulness-guard.test.mjs"],
  ["bash-guard-test.mjs",              "unit/extensions/safety/bash-guard.test.mjs"],
  ["guard-replacement-test.mjs",       "unit/extensions/safety/guard-replacement.test.mjs"],
  ["grounding-rule-test.mjs",          "unit/extensions/safety/grounding-rule.test.mjs"],
  ["patient-profile-test.mjs",         "unit/extensions/safety/patient-profile.test.mjs"],
  ["patient-forget-test.mjs",          "unit/extensions/safety/patient-forget.test.mjs"],
  ["compliance-test.mjs",              "unit/extensions/safety/compliance.test.mjs"],
  // eval
  ["eval-gate-test.mjs",              "unit/extensions/eval/gate.test.mjs"],
  ["llm-judge-test.mjs",              "unit/extensions/eval/llm-judge.test.mjs"],
  // state
  ["conversation-state-test.mjs",      "unit/extensions/state/conversation-state.test.mjs"],
  ["clarification-loop-test.mjs",      "unit/extensions/state/clarification-loop.test.mjs"],

  // ─── lib/ ──────────────────────────────
  ["retrieval-router-test.mjs",        "unit/lib/retrieval-router.test.mjs"],
  ["retrieval-fts-test.mjs",           "unit/lib/retrieval-fts.test.mjs"],
  ["retrieval-cache-test.mjs",         "unit/lib/retrieval-cache.test.mjs"],
  ["kg-graph-test.mjs",                "unit/lib/kg-graph.test.mjs"],
  ["knowledge-engine-search-test.mjs", "unit/lib/knowledge-engine-search.test.mjs"],
  ["conflict-detector-test.mjs",       "unit/lib/conflict-detector.test.mjs"],
  ["rag-search-version-hint-test.mjs", "unit/lib/rag-search-version-hint.test.mjs"],
  ["query-sanitize-test.mjs",          "unit/lib/query-sanitize.test.mjs"],
  ["p1-enhancements-test.mjs",         "unit/lib/p1-enhancements.test.mjs"],
  ["engine-version-test.mjs",          "unit/lib/engine-version.test.mjs"],
  ["chinese-heading-test.mjs",         "unit/lib/chinese-heading.test.mjs"],
  ["observability-test.mjs",           "unit/lib/observability.test.mjs"],
  ["diagnostic-log-test.mjs",          "unit/lib/diagnostic-log.test.mjs"],
  ["alert-log-test.mjs",               "unit/lib/alert-log.test.mjs"],
  ["audit-logger-test.mjs",            "unit/lib/audit-logger.test.mjs"],
  ["audit-chain-test.mjs",             "unit/lib/audit-chain.test.mjs"],
  ["parse-params-test.mjs",            "unit/lib/parse-params.test.mjs"],
  ["kb-sources-test.mjs",              "unit/lib/kb-sources.test.mjs"],
  ["extract-entities-test.mjs",        "unit/lib/extract-entities.test.mjs"],
  ["citation-check-test.mjs",          "unit/lib/citation-check.test.mjs"],

  // ─── scripts/service/ ──────────────────
  ["api-server-test.mjs",              "unit/scripts/service/api-server.test.mjs"],
  ["session-pool-test.mjs",            "unit/scripts/service/session-pool.test.mjs"],
  ["pi-runner-test.mjs",               "unit/scripts/service/pi-runner.test.mjs"],
  ["provider-health-test.mjs",         "unit/scripts/service/provider-health.test.mjs"],

  // ─── scripts/proxy/ ────────────────────
  ["provider-proxy-test.mjs",          "unit/scripts/proxy/provider-proxy.test.mjs"],

  // ─── scripts/kb/lifecycle/ ────────────
  ["deprecate-versions-test.mjs",      "unit/scripts/kb/lifecycle/deprecate-versions.test.mjs"],

  // ─── scripts/kb/multisource/ ────────────
  // 注: quality-gate-test.mjs 有新旧两份(flat 9KB 新版 vs multisource 4KB 旧版)
  // 新版覆盖旧版 → 先删旧版，再迁新版
  ["multisource/quality-gate-test.mjs",  "DELETE"],  // 旧版，被新版取代
  ["quality-gate-test.mjs",              "unit/scripts/kb/multisource/quality-gate.test.mjs"],
  ["multisource/normalize-test.mjs",     "unit/scripts/kb/multisource/normalize.test.mjs"],

  // ─── scripts/eval/ ────────────────────
  ["ab-prompt-eval-test.mjs",          "unit/scripts/eval/ab/prompt-eval.test.mjs"],
  ["generate-ab-input-test.mjs",       "unit/scripts/eval/ab/generate-input.test.mjs"],
  ["chunk-quality-test.mjs",           "unit/scripts/eval/quality/chunk-quality.test.mjs"],
  ["content-need-alignment-test.mjs",  "unit/scripts/eval/quality/content-need-alignment.test.mjs"],
  ["merge-into-gold-test.mjs",         "unit/scripts/eval/pipeline/merge-into-gold.test.mjs"],
  ["feedback-loop-test.mjs",           "unit/scripts/eval/pipeline/feedback-loop.test.mjs"],

  // ─── 留在 unit/ 根部的数据/工具测试 ───
  // quality-gate-test.mjs 已在 multisource/ 下

  // ─── integration/ (需 LLM Key / 真实 DB) ──
  ["answer-eval-bench.mjs",             "integration/answer-eval-bench.mjs"],
  ["answer-quality-judge.mjs",          "integration/answer-quality-judge.mjs"],
  ["eval-bench.mjs",                    "integration/eval-bench.mjs"],
];

// 记录统计
let moved = 0, failed = 0;

for (const [oldName, newPath] of MAPPING) {
  const oldFile = join(ROOT, "tests", "unit", oldName);
  const newFile = join(ROOT, "tests", newPath);

  if (!existsSync(oldFile)) {
    console.log(`  ⚠ 源文件不存在: ${oldName} (可能已迁移)`);
    failed++;
    continue;
  }

  if (newPath === "DELETE") {
    // 特殊标记: 删除旧文件（被新版取代）
    if (dryRun) {
      console.log(`  [dry-run] DELETE ${oldName}`);
    } else {
      execSync(`git rm "${oldFile}"`, { cwd: ROOT, stdio: "pipe" });
      console.log(`  🗑 DELETE ${oldName}`);
    }
    moved++;
    continue;
  }

  if (existsSync(newFile)) {
    console.log(`  ⚠ 目标已存在: ${newPath}`);
    failed++;
    continue;
  }

  if (dryRun) {
    console.log(`  [dry-run] ${oldName} → ${newPath}`);
    moved++;
    continue;
  }

  // 1. git mv
  try {
    execSync(`git mv "${oldFile}" "${newFile}"`, { cwd: ROOT, stdio: "pipe" });
  } catch (e) {
    console.error(`  ✗ git mv 失败: ${oldName}: ${e.message}`);
    failed++;
    continue;
  }

  // 2. 读取文件
  let content = readFileSync(newFile, "utf-8");

  // 3. 替换 import 路径
  // 旧: "../../.pi/" → 需要改为 "../../../.pi/" (加一级 ../)
  // 旧: "../../scripts/" → 需要改为 "../../../scripts/"
  // 但需要根据目标深度来决定替换规则

  // 计算目标深度
  const depth = (newPath.match(/\//g) || []).length; // 不含 unit/ 本身
  // tests/unit/ → depth=0, tests/unit/lib/ → depth=1
  // tests/unit/extensions/safety/ → depth=2
  // tests/unit/scripts/service/ → depth=2
  // tests/unit/scripts/kb/lifecycle/ → depth=3

  // 旧路径从 tests/unit/ 出发是 "../../" (2级上溯)
  // 新路径从 tests/unit/xxx/yyy/ 出发是 "../../.." (2+depth 级上溯)
  const extraDots = depth; // 每个子目录多加一级 ../

  // 替换模式: 把 ../../ 替换为 ../../.. + extraDots 个 /..
  if (extraDots > 0) {
    const prefix = "../".repeat(extraDots + 2); // 总上溯 = 2 + extraDots
    // 替换 `import { ... } from "../../.pi/` → `import { ... } from "${prefix}.pi/"`
    content = content.replace(
      /from\s+["']\.\.\/\.\.\/(\.pi\/|scripts\/|tests\/)/g,
      (match, p1) => `from "${prefix}${p1}`
    );
    // 替换 `pathToFileURL(join(__dirname, "..", "..", ...)` 模式
    content = content.replace(
      /(HERE|__dirname|ROOT),?\s*["']\.\.[\"'],?\s*["']\.\.[\"']/g,
      (match) => {
        const extra = Array(extraDots).fill('".."').join(", ");
        return match.replace(/"\."',?\s*"\.\."'/, (inner) => {
          return inner + (extra ? ", " + extra : "");
        });
      }
    );
  }

  writeFileSync(newFile, content, "utf-8");

  console.log(`  ✓ ${oldName} → ${newPath} (depth=${depth})`);
  moved++;
}

if (dryRun) {
  console.log(`\n演练完成: ${moved} 个文件就绪, ${failed} 个异常`);
  console.log("不带 --dry-run 执行实际迁移");
} else {
  console.log(`\n迁移完成: ${moved} 个成功, ${failed} 个失败`);
}
