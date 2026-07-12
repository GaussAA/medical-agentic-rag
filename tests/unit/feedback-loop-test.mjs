// feedback-loop-test.mjs
// 维度五反馈闭环单测：依赖注入 mock 目录，零真实 logs，确定性。
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  collectSignals,
  aggregateHotspots,
  buildSuggestions,
  buildFeedbackQueue,
  writeFeedbackQueue,
  readFeedbackQueue,
  deriveGoldCandidates,
  consumeFeedback,
  resolveFeedback,
  SEVERITY,
} from "../../.pi/extensions/lib/feedback-loop.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) {
    pass++;
  } else {
    fail++;
    fails.push(msg);
    console.error("  ✗ " + msg);
  }
}

/** 构造隔离 fixture 目录。 */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "fb-"));
  const logsDir = join(root, "logs");
  const reportsDir = join(root, "reports");
  mkdirSync(logsDir, { recursive: true });
  mkdirSync(reportsDir, { recursive: true });
  return { root, logsDir, reportsDir };
}

// ── Case 1: guard_hit 归集 ──
{
  const { root, logsDir, reportsDir } = fixture();
  writeFileSync(
    join(logsDir, "2026-07-12.ndjson"),
    [
      JSON.stringify({ t: "T1", event: "guard_hit", type: "faithfulness", action: "block", reason: "halluc", guides: ["指南A"] }),
      JSON.stringify({ t: "T2", event: "guard_hit", type: "conflict", action: "annotate", guides: ["指南A", "指南B"] }),
      JSON.stringify({ t: "T3", event: "session", type: "start" }), // 非 guard_hit，应忽略
    ].join("\n") + "\n",
  );
  const sig = collectSignals({ logsDir, reportsDir });
  const gh = sig.filter((s) => s.src === "guard_hit");
  ok(gh.length === 2, "guard_hit 归集 2 条");
  ok(gh.find((s) => s.type === "faithfulness_block")?.severity === SEVERITY.HIGH, "block → high");
  ok(gh.find((s) => s.type === "conflict_annotate")?.severity === SEVERITY.MEDIUM, "annotate → medium");
  ok(sig.find((s) => s.src === "session") === undefined, "非 guard_hit 被忽略");
  rmSync(root, { recursive: true, force: true });
}

// ── Case 2: eval 低分归集（含 null judge 跳过）──
{
  const { root, logsDir, reportsDir } = fixture();
  writeFileSync(
    join(reportsDir, "answer-quality-report.json"),
    JSON.stringify({
      items: [
        { guides: ["G1"], llmJudge: { faithfulness: 0.55, answerRelevance: 0.9, clinicalCorrectness: 0.85, safety: 1 } },
        { guides: ["G2"], llmJudge: { faithfulness: 0.75, answerRelevance: 0.7, clinicalCorrectness: 0.8, safety: 1 } },
        { guides: ["G3"], llmJudge: null }, // 应跳过
      ],
    }),
  );
  const sig = collectSignals({ logsDir, reportsDir });
  const ev = sig.filter((s) => s.src === "eval");
  ok(ev.length === 3, "eval 低分归集 3 条 (0.55→high, 0.75/0.7→medium)");
  ok(ev.find((s) => s.type === "eval_low_faithfulness")?.severity === SEVERITY.HIGH, "faithfulness 0.55 → high");
  ok(ev.find((s) => s.type === "eval_low_answerRelevance")?.severity === SEVERITY.MEDIUM, "answerRelevance 0.7 → medium");
  rmSync(root, { recursive: true, force: true });
}

// ── Case 3: PHI 合规异常归集 ──
{
  const { root, logsDir, reportsDir } = fixture();
  writeFileSync(
    join(reportsDir, "observability-report.json"),
    JSON.stringify({ phiAudit: { nonCompliant: ["logs/x.ndjson 含 prompt 字段"] } }),
  );
  const sig = collectSignals({ logsDir, reportsDir });
  const phi = sig.filter((s) => s.src === "phi");
  ok(phi.length === 1 && phi[0].severity === SEVERITY.HIGH, "PHI 异常归集为 high");
  rmSync(root, { recursive: true, force: true });
}

// ── Case 4: 聚合热点分组 + 严重度取最高 ──
{
  const sig = [
    { src: "guard_hit", type: "conflict_annotate", severity: SEVERITY.MEDIUM, guides: ["A", "B"] },
    { src: "guard_hit", type: "conflict_annotate", severity: SEVERITY.HIGH, guides: ["B", "A"] }, // 同 guides 不同顺序
    { src: "guard_hit", type: "faithfulness_block", severity: SEVERITY.HIGH, guides: [] },
  ];
  const hot = aggregateHotspots(sig);
  ok(hot.length === 2, "热点聚合为 2 组 (guides 顺序归一)");
  const c = hot.find((h) => h.type === "conflict_annotate");
  ok(c.count === 2 && c.severity === SEVERITY.HIGH, "conflict 组 count=2 且 severity 取最高 high");
}

// ── Case 5: 建议文本生成 ──
{
  const hot = [
    { type: "conflict_annotate", guides: ["指南A", "指南B"], count: 3, severity: SEVERITY.MEDIUM },
    { type: "faithfulness_block", guides: [], count: 1, severity: SEVERITY.HIGH },
    { type: "eval_low_safety", guides: ["G"], count: 2, severity: SEVERITY.MEDIUM },
    { type: "phi_noncompliant", guides: [], count: 1, severity: SEVERITY.HIGH },
  ];
  const sug = buildSuggestions(hot);
  ok(sug[0].suggestion.includes("跨指南冲突"), "conflict → 对齐/补录建议");
  ok(sug[1].suggestion.includes("系统提示"), "faithfulness_block → 系统提示建议");
  ok(sug[2].suggestion.includes("gold"), "eval_low → gold 建议");
  ok(sug[3].suggestion.includes("PHI"), "phi → 排查建议");
}

// ── Case 6: 端到端队列构建 + 落盘读回 ──
{
  const { root, logsDir, reportsDir } = fixture();
  writeFileSync(
    join(logsDir, "2026-07-12.ndjson"),
    JSON.stringify({ t: "T", event: "guard_hit", type: "conflict", action: "annotate", guides: ["A", "B"] }) + "\n",
  );
  const q = buildFeedbackQueue({ logsDir, reportsDir });
  ok(q.summary.totalSignals === 1, "队列汇总信号数=1");
  ok(q.summary.medium === 1, "队列 medium=1");
  ok(q.hotspots.length === 1 && q.hotspots[0].suggestion.length > 0, "热点含建议");

  const out = join(root, "feedback-queue.json");
  const written = writeFeedbackQueue(q, out);
  ok(existsSync(written), "队列落盘");
  const back = JSON.parse(readFileSync(written, "utf-8"));
  ok(back.summary.totalSignals === 1, "落盘读回一致");
  rmSync(root, { recursive: true, force: true });
}

// ── Case 7: 空输入不崩 ──
{
  const { root, logsDir, reportsDir } = fixture();
  const q = buildFeedbackQueue({ logsDir, reportsDir });
  ok(q.summary.totalSignals === 0 && q.hotspots.length === 0, "空输入安全返回空队列");
  rmSync(root, { recursive: true, force: true });
}

// ── Case 8: 读取 API 读回一致 ──
{
  const { root, logsDir, reportsDir } = fixture();
  const out = join(root, "feedback-queue.json");
  writeFileSync(
    join(logsDir, "2026-07-12.ndjson"),
    JSON.stringify({ t: "T", event: "guard_hit", type: "conflict", action: "annotate", guides: ["A", "B"] }) + "\n",
  );
  const q = buildFeedbackQueue({ logsDir, reportsDir });
  writeFeedbackQueue(q, out);
  const back = readFeedbackQueue(out);
  ok(back && back.summary.totalSignals === 1, "readFeedbackQueue 读回一致");
  ok(readFeedbackQueue(join(root, "nope.json")) === null, "缺失队列返回 null 不崩");
  rmSync(root, { recursive: true, force: true });
}

// ── Case 9: 派生 gold 候选仅取评测/忠实度类，existingIds 去重 ──
{
  const hotspots = [
    { type: "eval_low_faithfulness", guides: ["肝癌指南2026"], count: 3, severity: SEVERITY.HIGH, suggestion: "补 faith gold" },
    { type: "faithfulness_annotate", guides: ["肺炎指南"], count: 2, severity: SEVERITY.MEDIUM, suggestion: "补 anno gold" },
    { type: "conflict_annotate", guides: ["A", "B"], count: 5, severity: SEVERITY.HIGH, suggestion: "冲突对齐" },
    { type: "phi_noncompliant", guides: [], count: 1, severity: SEVERITY.HIGH, suggestion: "PHI 排查" },
  ];
  const c1 = deriveGoldCandidates({ hotspots });
  ok(c1.length === 2, "仅 2 条评测/忠实度类转为候选（冲突/PHI 跳过）");
  ok(c1[0].status === "candidate" && c1[0].department.includes("肝癌"), "候选含 department + status");
  const c2 = deriveGoldCandidates({ hotspots }, { existingIds: [c1[0].id] });
  ok(c2.length === 1 && c2[0].id !== c1[0].id, "existingIds 去重生效");
}

// ── Case 10: 消费编排跳过已解决热点 ──
{
  const { root, logsDir, reportsDir } = fixture();
  const out = join(root, "feedback-queue.json");
  const resolvedPath = join(root, "feedback-resolved.json");
  const q = {
    summary: { totalSignals: 3 },
    hotspots: [
      { type: "eval_low_safety", guides: ["G1"], count: 2, severity: SEVERITY.MEDIUM, suggestion: "补 safety gold" },
      { type: "faithfulness_block", guides: ["G2"], count: 1, severity: SEVERITY.HIGH, suggestion: "补 fb gold" },
      { type: "conflict_annotate", guides: ["G3"], count: 4, severity: SEVERITY.HIGH, suggestion: "冲突" },
    ],
  };
  writeFeedbackQueue(q, out);
  const rec1 = consumeFeedback({ queuePath: out, resolvedPath });
  ok(rec1.consumed && rec1.openHotspots === 3 && rec1.goldCandidates.length === 2, "首轮消费 3 开放、派生 2 候选");
  // 标记第一条为已解决
  const key = `eval_low_safety::G1`;
  resolveFeedback([key], resolvedPath);
  const rec2 = consumeFeedback({ queuePath: out, resolvedPath });
  ok(rec2.resolvedSkipped === 1 && rec2.openHotspots === 2 && rec2.goldCandidates.length === 1, "已解决项被跳过，候选减为 1");
  const rec3 = consumeFeedback({ queuePath: join(root, "missing.json") });
  ok(rec3.consumed === false && rec3.reason === "no-queue", "无队列返回 consumed:false");
  rmSync(root, { recursive: true, force: true });
}

console.log(`\n反馈闭环单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
