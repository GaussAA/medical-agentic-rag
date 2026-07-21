// 观测埋点单测（闭环 P2-③：原仅 guard_hit 单一维度，现扩 6 类事件）
import { rmSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  logGuardHit,
  logRetrieval,
  logEngineFallback,
  logFaithfulness,
  logAuditEvent,
  logFeedbackGen,
  EVENTS,
} from "../../../.pi/extensions/lib/observability.mjs";

let pass = 0;
let fail = 0;
function ok(c, m) {
  if (c) pass++;
  else {
    fail++;
    console.error("✗ " + m);
  }
}

async function main() {
  const root = mkdtempSync(join(tmpdir(), "obs-"));
  const logsDir = join(root, ".pi", "logs");

  // 各事件落盘
  await logGuardHit({ type: "faithfulness", action: "block", reason: "R", guides: ["g1"], logsDir });
  await logRetrieval({ queryLen: 10, kbId: "kb", kbResolved: true, hits: 5, totalFiles: 100, ms: 42.1, engineMode: "dense", logsDir });
  await logEngineFallback({ reason: "lazy_init_failed:x", logsDir });
  await logFaithfulness({ action: "pass", score: 0.7, reason: "low", logsDir });
  await logAuditEvent({ action: "user_turn", logsDir });
  await logFeedbackGen({ signals: 12, hotspots: 3, suggestions: 3, topSeverity: "high", logsDir });
  // 字段收窄：非数字字段应剔除（undefined），不得写入 NaN/字符串
  await logRetrieval({ hits: "abc", ms: "x", logsDir });

  const date = new Date().toISOString().slice(0, 10);
  const lines = readFileSync(join(logsDir, `${date}.ndjson`), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

  ok(lines.length === 7, `应落 7 条事件，实际 ${lines.length}`);
  const byEvent = (e) => lines.filter((l) => l.event === e);

  ok(byEvent("guard_hit").length === 1, "guard_hit 落盘 1 条");
  const gh = byEvent("guard_hit")[0];
  ok(
    gh.type === "faithfulness" && gh.action === "block" && gh.reason === "R" && Array.isArray(gh.guides),
    "guard_hit 字段正确（复用 emit，无重复 try/catch）",
  );

  ok(byEvent("retrieval").length === 2, "retrieval 落盘 2 条");
  const r1 = byEvent("retrieval").find((l) => l.hits === 5);
  ok(
    r1 && r1.queryLen === 10 && r1.kbResolved === true && r1.totalFiles === 100 && r1.ms === 42.1 && r1.engineMode === "dense",
    "retrieval 正常字段正确",
  );
  const r2 = byEvent("retrieval").find((l) => !("hits" in l));
  ok(r2 && r2.hits === undefined && r2.ms === undefined, "retrieval 非数字字段收窄为 undefined（不写 NaN）");

  const ef = byEvent("engine_fallback")[0];
  ok(ef && ef.reason === "lazy_init_failed:x", "engine_fallback 字段正确");

  const fh = byEvent("faithfulness")[0];
  ok(fh.action === "pass" && fh.score === 0.7 && fh.reason === "low", "faithfulness 软信号字段正确");

  const ae = byEvent("audit_event")[0];
  ok(ae && ae.action === "user_turn", "audit_event 字段正确");

  const fg = byEvent("feedback_gen")[0];
  ok(
    fg.signals === 12 && fg.hotspots === 3 && fg.suggestions === 3 && fg.topSeverity === "high",
    "feedback_gen 计数字段正确",
  );

  ok(EVENTS.has("guard_hit") && EVENTS.size === 6, `EVENTS 含 6 类事件（实际 ${EVENTS.size}）`);

  rmSync(root, { recursive: true, force: true });
  console.log(`\n观测埋点单测: ${pass} 通过 / ${fail} 失败`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
