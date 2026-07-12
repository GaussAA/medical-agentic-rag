// observability-test.mjs
// 可观测性聚合 + 埋点单测：注入临时目录与 mock 数据，零依赖真实 logs/reports。
// 覆盖：会话/prompt 计数、guard_hit 分桶、PHI 合规扫描（坏 prompt 事件→不合规）、
// eval 基线聚合（含 null judge 过滤）、护栏部署检查（真实根→true / 空根→false）、
// logGuardHit 落盘后可被聚合读到。

import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aggregate } from "../../scripts/ops/observability-report.mjs";
import { logGuardHit } from "../../.pi/extensions/lib/observability.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
    console.error("  ✗ " + name);
  }
}

function mkd() {
  return mkdtempSync(join(tmpdir(), "obs-test-"));
}

// 写一份业务 ndjson（含 session_start / prompt / guard_hit）+ 一份 audit
function writeLogs(logsDir, { badPrompt = false } = {}) {
  mkdirSync(logsDir, { recursive: true });
  const biz = [
    JSON.stringify({ t: "2026-07-12T00:00:00Z", event: "session_start", sessionId: "s1" }),
    JSON.stringify({ t: "2026-07-12T00:00:01Z", event: "prompt", promptLength: 30, hasImages: false }),
    JSON.stringify({ t: "2026-07-12T00:00:02Z", event: "guard_hit", type: "faithfulness", action: "annotate", reason: "low_faith" }),
    JSON.stringify({ t: "2026-07-12T00:00:03Z", event: "guard_hit", type: "conflict", action: "annotate", guides: ["G1", "G2"] }),
    badPrompt
      ? JSON.stringify({ t: "2026-07-12T00:00:04Z", event: "prompt", promptLength: 30, hasImages: false, prompt: "这是一段疑似用户原文内容超过合规范围" })
      : JSON.stringify({ t: "2026-07-12T00:00:04Z", event: "prompt", promptLength: 12, hasImages: false }),
  ].join("\n");
  writeFileSync(join(logsDir, "2026-07-12.ndjson"), biz + "\n");
  writeFileSync(
    join(logsDir, "audit-2026-07-12.ndjson"),
    JSON.stringify({ t: "2026-07-12T00:00:00Z", event: "phi_read", field: "name", sessionId: "s1" }) + "\n",
  );
}

function writeEval(reportsDir) {
  mkdirSync(reportsDir, { recursive: true });
  const report = {
    metrics: {
      endToEnd: { live: 14 },
      kpi: {
        citationRecall: 92.3,
        evidenceLocatability: 93.1,
        forbiddenViolationRate: 0,
        refusalAccuracy: 100,
        llmJudge: { faithfulness: 0.99, answerRelevance: 1, clinicalCorrectness: 1, safety: 1, n: 13 },
      },
    },
    details: [
      { id: "Q01", judge: { faithfulness: 0.9, answerRelevance: 1, clinicalCorrectness: 1, safety: 1 } },
      { id: "Q07", judge: { faithfulness: null, answerRelevance: null, clinicalCorrectness: null, safety: null } },
    ],
  };
  writeFileSync(join(reportsDir, "answer-quality-report.json"), JSON.stringify(report));
}

async function run() {
  // Case 1：正常数据 + 真实根 cwd（护栏应部署）
  {
    const root = mkd();
    const logsDir = join(root, "logs");
    const reportsDir = join(root, "reports");
    writeLogs(logsDir);
    writeEval(reportsDir);
    const r = aggregate(logsDir, reportsDir, process.cwd()); // 真实项目根 → guardsDeployed 期望 true
    ok(r.sessions === 1, "sessions 计数=1");
    ok(r.prompts === 2, "prompts 计数=2");
    ok(r.guardHits.total === 2, "guard_hits 总数=2");
    ok(r.guardHits.faithfulness.annotate === 1, "faithfulness.annotate=1");
    ok(r.guardHits.conflict.annotate === 1, "conflict.annotate=1");
    ok(r.phiAudit.entries === 1, "phiAudit 条目=1");
    ok(r.phiAudit.compliant === true, "PHI 合规=true（正常 prompt 事件）");
    ok(r.eval.available === true, "eval 可用");
    ok(r.eval.citationRecall === 92.3, "eval 引用召回=92.3");
    ok(r.eval.judge.faithfulness === 0.9, "eval judge 四维均值过滤 null 后=0.9");
    ok(r.eval.judge.n === 13, "eval judge.n=13");
    ok(r.guardsDeployed.faithfulness === true, "护栏 faithfulness 部署=true（真实根）");
    ok(r.guardsDeployed.conflict === true, "护栏 conflict 部署=true（真实根）");
    ok(r.health.overall === "healthy", "整体健康=healthy（无 warn）");
    rmSync(root, { recursive: true, force: true });
  }

  // Case 2：坏 prompt 事件 → PHI 不合规 → warn
  {
    const root = mkd();
    const logsDir = join(root, "logs");
    const reportsDir = join(root, "reports");
    writeLogs(logsDir, { badPrompt: true });
    writeEval(reportsDir);
    const r = aggregate(logsDir, reportsDir, mkd()); // 空 cwd → 护栏未部署 → 额外 warn
    ok(r.phiAudit.compliant === false, "PHI 合规=false（prompt 含原文）");
    ok(r.health.warnings.some((w) => w.includes("PHI")), "warnings 含 PHI 不合规");
    ok(r.guardsDeployed.faithfulness === false, "空根→faithfulness 未部署=false");
    ok(r.health.warnings.some((w) => w.includes("faithfulness")), "warnings 含护栏未部署");
    rmSync(root, { recursive: true, force: true });
  }

  // Case 3：logGuardHit 落盘（临时目录隔离）可被聚合读到
  {
    const root = mkd();
    const logsDir = join(root, "logs");
    mkdirSync(logsDir, { recursive: true });
    await logGuardHit({ type: "conflict", action: "annotate", guides: ["A", "B"], logsDir });
    writeFileSync(
      join(logsDir, "extra.ndjson"),
      JSON.stringify({ t: "x", event: "guard_hit", type: "faithfulness", action: "block" }) + "\n",
    );
    const r = aggregate(logsDir, join(root, "reports"), mkd());
    ok(r.guardHits.conflict.annotate === 1, "logGuardHit 写入被聚合读到 conflict.annotate=1");
    ok(r.guardHits.faithfulness.block === 1, "faithfulness.block=1");
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log("失败项:");
    for (const f of fails) console.log("  -", f);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(1);
});
