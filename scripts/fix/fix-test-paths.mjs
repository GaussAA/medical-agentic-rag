/**
 * scripts/fix/fix-test-paths.mjs
 * 修复 package.json 中所有指向已移动/重命名测试文件的路径。
 * 测试文件从 tests/unit/<name>-test.mjs 重组到子目录 <name>.test.mjs。
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const PKG_PATH = join(ROOT, "package.json");
const pkg = JSON.parse(readFileSync(PKG_PATH, "utf-8"));

// 全部旧→新路径映射（仅 tests/unit/ 下的断链）
const PATH_MAP = {
  "tests/unit/conversation-state-test.mjs": "tests/unit/extensions/state/conversation-state.test.mjs",
  "tests/unit/patient-profile-test.mjs": "tests/unit/extensions/safety/patient-profile.test.mjs",
  "tests/unit/clarification-loop-test.mjs": "tests/unit/extensions/state/clarification-loop.test.mjs",
  "tests/unit/grounding-rule-test.mjs": "tests/unit/extensions/safety/grounding-rule.test.mjs",
  "tests/unit/llm-judge-test.mjs": "tests/unit/extensions/eval/llm-judge.test.mjs",
  "tests/unit/kg-graph-test.mjs": "tests/unit/lib/kg-graph.test.mjs",
  "tests/unit/retrieval-router-test.mjs": "tests/unit/lib/retrieval-router.test.mjs",
  "tests/unit/retrieval-fts-test.mjs": "tests/unit/lib/retrieval-fts.test.mjs",
  "tests/unit/faithfulness-guard-test.mjs": "tests/unit/extensions/safety/faithfulness-guard.test.mjs",
  "tests/unit/conflict-detector-test.mjs": "tests/unit/lib/conflict-detector.test.mjs",
  "tests/unit/rag-search-version-hint-test.mjs": "tests/unit/lib/rag-search-version-hint.test.mjs",
  "tests/unit/scope-guard-test.mjs": "tests/unit/extensions/safety/scope-guard.test.mjs",
  "tests/unit/query-sanitize-test.mjs": "tests/unit/lib/query-sanitize.test.mjs",
  "tests/unit/eval-gate-test.mjs": "tests/unit/extensions/eval/gate.test.mjs",
  "tests/unit/audit-logger-test.mjs": "tests/unit/lib/audit-logger.test.mjs",
  "tests/unit/engine-version-test.mjs": "tests/unit/lib/engine-version.test.mjs",
  "tests/unit/observability-test.mjs": "tests/unit/lib/observability.test.mjs",
  "tests/unit/diagnostic-log-test.mjs": "tests/unit/lib/diagnostic-log.test.mjs",
  "tests/unit/provider-health-test.mjs": "tests/unit/scripts/service/provider-health.test.mjs",
  "tests/unit/alert-log-test.mjs": "tests/unit/lib/alert-log.test.mjs",
  "tests/unit/multisource/quality-gate-test.mjs": "tests/unit/scripts/kb/multisource/quality-gate.test.mjs",
  "tests/unit/multisource/normalize-test.mjs": "tests/unit/scripts/kb/multisource/normalize.test.mjs",
  "tests/unit/merge-into-gold-test.mjs": "tests/unit/scripts/eval/pipeline/merge-into-gold.test.mjs",
  "tests/unit/guard-replacement-test.mjs": "tests/unit/extensions/safety/guard-replacement.test.mjs",
  "tests/unit/patient-forget-test.mjs": "tests/unit/extensions/safety/patient-forget.test.mjs",
  "tests/unit/chunk-quality-test.mjs": "tests/unit/scripts/eval/quality/chunk-quality.test.mjs",
  "tests/unit/chinese-heading-test.mjs": "tests/unit/lib/chinese-heading.test.mjs",
  "tests/unit/ab-prompt-eval-test.mjs": "tests/unit/scripts/eval/ab/prompt-eval.test.mjs",
  "tests/unit/generate-ab-input-test.mjs": "tests/unit/scripts/eval/ab/generate-input.test.mjs",
  "tests/unit/content-need-alignment-test.mjs": "tests/unit/scripts/eval/quality/content-need-alignment.test.mjs",
  "tests/unit/api-server-test.mjs": "tests/unit/scripts/service/api-server.test.mjs",
  "tests/unit/session-pool-test.mjs": "tests/unit/scripts/service/session-pool.test.mjs",
  "tests/unit/knowledge-engine-search-test.mjs": "tests/unit/lib/knowledge-engine-search.test.mjs",
  "tests/unit/eval-bench.mjs": "tests/unit/eval-bench.mjs",
  "tests/unit/answer-eval-bench.mjs": "tests/unit/answer-eval-bench.mjs",
};

// 验证新路径全部存在
console.log("预检查新路径:");
let allValid = true;
for (const [oldPath, newPath] of Object.entries(PATH_MAP)) {
  const exists = existsSync(newPath);
  if (!exists) console.log(`  ❌ ${newPath} — 不存在`);
  allValid = allValid && exists;
}
if (!allValid) {
  console.error("\n⚠ 部分新路径不存在，请核查。脚本继续但可能写入无效路径。");
}

// 修复 test:legacy
let legacy = pkg.scripts["test:legacy"];
if (legacy) {
  const original = legacy;
  for (const [oldPath, newPath] of Object.entries(PATH_MAP)) {
    // 精确替换路径（区别于 tests/unit/api-server-test.mjs → tests/unit/scripts/service/api-server.test.mjs）
    legacy = legacy.split(oldPath).join(newPath);
  }
  pkg.scripts["test:legacy"] = legacy;
  if (legacy !== original) {
    // 统计替换次数
    let count = 0;
    for (const [oldPath, newPath] of Object.entries(PATH_MAP)) {
      const oc = (original.match(new RegExp(oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (oc > 0) count += oc;
    }
    console.log(`✅ test:legacy 已修复（${count} 处路径替换）`);
  }
}

// 修复独立 test:* 脚本
const FIX_MAP = {
  "test:retrieval-engine": "tests/unit/lib/knowledge-engine-search.test.mjs",
  "test:guard": "tests/unit/extensions/safety/faithfulness-guard.test.mjs",
  "test:conflict": "tests/unit/lib/conflict-detector.test.mjs",
  "test:version-hint": "tests/unit/lib/rag-search-version-hint.test.mjs",
  "test:chunk-quality": "tests/unit/scripts/eval/quality/chunk-quality.test.mjs",
  "test:align": "tests/unit/scripts/eval/quality/content-need-alignment.test.mjs",
  "test:kg": "tests/unit/lib/kg-graph.test.mjs",
  "test:pool": "tests/unit/scripts/service/session-pool.test.mjs",
  "test:state": "tests/unit/extensions/state/conversation-state.test.mjs",
  "test:profile": "tests/unit/extensions/safety/patient-profile.test.mjs",
  "test:clarify-loop": "tests/unit/extensions/state/clarification-loop.test.mjs",
  "test:grounding": "tests/unit/extensions/safety/grounding-rule.test.mjs",
};

let scriptFixes = 0;
for (const [key, newPath] of Object.entries(FIX_MAP)) {
  const cmd = pkg.scripts[key];
  if (!cmd) continue;
  // 提取 cmd 中的路径部分（在 node ... 之后）
  const match = cmd.match(/^(node\s+(?:--[^\s]+\s+)*)(tests\/\S+)$/);
  if (match) {
    const oldPath = match[2];
    if (!existsSync(oldPath) && existsSync(newPath)) {
      pkg.scripts[key] = match[1] + newPath;
      console.log(`✅ ${key}: ${oldPath} → ${newPath}`);
      scriptFixes++;
    }
  }
}

writeFileSync(PKG_PATH, JSON.stringify(pkg, null, 2), "utf-8");
console.log(`\n完成。test:legacy + ${scriptFixes} 个独立脚本已修复。`);
