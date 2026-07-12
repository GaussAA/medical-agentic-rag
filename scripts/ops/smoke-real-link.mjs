// smoke-real-link.mjs
// 真实链路冒烟：在「有真库」的运行环境（本地开发机 / 自托管 nightly runner）跑通
// 『FTS 构建 → 路由约束 → hybrid 检索 → 真引擎』全链路，而非仅内存逻辑单测。
//
// 背景（P2-④）：CI 为纯逻辑门禁（SKIP_KB，medical-raw-txt 不入库、无原生引擎），
// retrieval-fts-test / knowledge-engine-search-test 仅用内存临时库验证「函数正确性」，
// 从未在真实 knowledge.db + 真实引擎上跑过端到端。本脚本补足该缺口。
//
// 探针零杜撰：锚点查询从「真库实时抽取的真实 file_path」派生，必命中该指南自身 chunk，
// 杜绝写死虚构指南名导致误报。
//
// 退出码（与 pre-push / nightly 约定一致）：
//   0 = 通过（真实链路健康）
//   1 = 真实链路故障（FTS 构建失败 / 签名漂移 / 检索召回为空 / 引擎路径断裂）
//   2 = 跳过（本环境无真库，CI/nightly 宿主机无 KB 时优雅跳过，不阻塞）
//
// 用法：
//   node scripts/ops/smoke-real-link.mjs            # 默认：FTS 校验 + 检索探针（无 LLM）
//   node scripts/ops/smoke-real-link.mjs --json     # 强制打印 JSON 报告
// 本脚本不调用 LLM（保持 pre-push 轻量）；端到端质量判定由 nightly answer-quality-judge 负责。

import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import {
  resolveKbDbPath,
  sourceSig,
  ensureFtsIndex,
  ftsDbPath,
  searchKnowledge,
  setKbDb,
  Database,
} from "../../.pi/extensions/lib/retrieval-router.mjs";
import { engineHybridSearch, isEngineAvailable } from "../../.pi/extensions/lib/knowledge-engine-search.mjs";

const FORCE_JSON = process.argv.includes("--json");
const REPORT_DIR = join(process.cwd(), "tests", "reports");

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  \u2713", name);
  } else {
    fail++;
    fails.push(name + (extra ? " :: " + extra : ""));
    console.log("  \u2717", name, extra);
  }
}

/** 从真库抽取 N 个真实 file_path 作探针锚点（零杜撰、必命中自身 chunk）。 */
function deriveProbes(db, n = 5) {
  const rows = db
    .prepare(
      "SELECT DISTINCT file_path FROM chunks WHERE file_path IS NOT NULL AND file_path <> '' ORDER BY rowid LIMIT ?",
    )
    .all(n);
  return rows
    .map((r) => String(r.file_path || "").replace(/\.md$/i, ""))
    .filter((t) => t.length >= 2);
}

async function main() {
  console.log("\n=== 真实链路冒烟 P2-④ ===");
  const kbPath = resolveKbDbPath();
  console.log("真库路径:", kbPath, kbPath && existsSync(kbPath) ? "(存在)" : "(缺失)");

  if (!kbPath || !existsSync(kbPath)) {
    const report = {
      generatedAt: new Date().toISOString(),
      status: "skip",
      reason: "no_live_kb",
      kbPath,
      message: "本环境无真库（CI / nightly 宿主机），真实链路冒烟优雅跳过。",
    };
    if (FORCE_JSON) console.log(JSON.stringify(report, null, 2));
    return { report, code: 2 };
  }

  const db = new Database(kbPath, { readonly: true, fileMustExist: true });
  setKbDb(db); // 注入只读连接，searchKnowledge 复用

  const totalChunks = db.prepare("SELECT COUNT(*) n FROM chunks").get().n;
  const totalFiles = db
    .prepare("SELECT COUNT(DISTINCT file_path) n FROM chunks WHERE file_path IS NOT NULL AND file_path <> ''")
    .get().n;
  console.log(`真库规模: ${totalChunks} chunks / ${totalFiles} files`);

  const report = {
    generatedAt: new Date().toISOString(),
    kbPath,
    totalChunks,
    totalFiles,
    fts: {},
    engine: { available: false, searched: 0, ok: 0 },
    probes: [],
    summary: {},
  };

  // ---- [1] FTS 构建 + 签名防漂移（根治 P1 索引漂移回归）----
  console.log("\n[1] FTS 构建 & 内容指纹签名校验");
  const sig = sourceSig(db);
  let fts = null;
  try {
    fts = ensureFtsIndex(db); // 惰性构建 / 失效重建
  } catch (e) {
    console.error("  FTS 构建抛异常:", e?.message || e);
  }
  if (!fts) {
    ok("FTS 索引可用（构建/复用成功）", false, "ensureFtsIndex 返回 null");
    report.fts = { built: false, sigMatch: false };
  } else {
    const stored = fts.prepare("SELECT v FROM meta WHERE k='sig' LIMIT 1").get();
    const sigMatch = !!stored && stored.v === sig;
    ok("FTS 索引可用（构建/复用成功）", true);
    ok("FTS 签名 == 源库内容指纹（无漂移）", sigMatch, `stored=${stored?.v} src=${sig}`);
    // staleBefore：重建前是否曾陈旧（构建期已自愈，仅记录）
    report.fts = { built: true, sigMatch, path: ftsDbPath(), srcSig: sig, storedSig: stored?.v };
  }

  // 自然语言临床探针（逼近真实 agent 查询，更能抓语义/排序回归；均经真库核验命中）
  const NL_PROBES = [
    "高血压患者长期管理的推荐方案",
    "2型糖尿病胰岛素治疗的起始时机",
    "乳腺癌术后辅助化疗指征",
    "儿童支原体肺炎首选大环内酯类",
    "慢性阻塞性肺疾病患者健康服务规范 基层 随访 评估",
    "结核病分类 WS 196 涂阴 菌阴 病原学阳性",
  ];

  // ---- [2] 探针：主路径 searchKnowledge（路由 + FTS + BM25）----
  console.log("\n[2] 检索探针 — searchKnowledge（路由 + FTS + BM25 主路径）");
  const probes = deriveProbes(db, 5);
  console.log("  锚点（真库抽取）:", probes.join(" | "));
  for (const q of probes) {
    let r;
    try {
      r = searchKnowledge(q, { limit: 5 });
    } catch (e) {
      ok(`检索「${q}」不抛异常`, false, e?.message || String(e));
      report.probes.push({ query: q, error: String(e?.message || e) });
      continue;
    }
    const grounded = !!(r.results && r.results.length >= 1 && r.results[0].snippet);
    ok(
      `检索「${q}」召回 >=1 接地结果`,
      grounded,
      `results=${r.results?.length ?? 0} top=${r.results?.[0]?.file_path ?? "空"}`,
    );
    report.probes.push({
      query: q,
      kind: "db-anchor",
      routingConstrained: !!r.constrained,
      routedTitles: r.routedTitles?.length ?? 0,
      topFile: r.results?.[0]?.file_path ?? null,
      topScore: r.results?.[0]?.score ?? 0,
      grounded,
    });
  }

  console.log("\n[2b] 自然语言临床探针（真实查询形态）");
  for (const q of NL_PROBES) {
    let r;
    try {
      r = searchKnowledge(q, { limit: 5 });
    } catch (e) {
      ok(`NL检索「${q}」不抛异常`, false, e?.message || String(e));
      continue;
    }
    const grounded = !!(r.results && r.results.length >= 1 && r.results[0].snippet);
    ok(
      `NL检索「${q}」召回 >=1 接地结果`,
      grounded,
      `results=${r.results?.length ?? 0} top=${r.results?.[0]?.file_path ?? "空"}`,
    );
    report.probes.push({
      query: q,
      kind: "nl-clinical",
      topFile: r.results?.[0]?.file_path ?? null,
      topScore: r.results?.[0]?.score ?? 0,
      grounded,
    });
  }

  // ---- [3] 引擎路径：engineHybridSearch（真 hybrid，可用才卡）----
  console.log("\n[3] 引擎路径 — engineHybridSearch（真 KnowledgeEngine hybrid）");
  let engineAvailable = false;
  try {
    engineAvailable = await isEngineAvailable();
  } catch {
    engineAvailable = false;
  }
  report.engine.available = engineAvailable;
  if (!engineAvailable) {
    console.log("  ⚠ 引擎不可用（未安装/懒加载失败）→ 跳过引擎路径断言（非故障，BM25 兜底仍生效）");
  } else {
    const allProbes = [...probes, ...NL_PROBES];
    for (const q of allProbes) {
      let eng;
      try {
        eng = await engineHybridSearch(q, { limit: 5 });
      } catch (e) {
        ok(`引擎检索「${q}」不抛异常`, false, e?.message || String(e));
        continue;
      }
      report.engine.searched++;
      const okEng = !!(eng && eng.ok && eng.results && eng.results.length >= 1);
      if (okEng) report.engine.ok++;
      ok(`引擎检索「${q}」召回 >=1 结果`, okEng, `ok=${eng?.ok} n=${eng?.results?.length ?? 0} err=${eng?.error ?? ""}`);
    }
  }

  // ---- 汇总 ----
  const groundedCount = report.probes.filter((p) => p.grounded).length;
  const probeCount = report.probes.length;
  report.summary = {
    probes: probeCount,
    grounded: groundedCount,
    ftsBuilt: !!report.fts.built,
    ftsSigMatch: !!report.fts.sigMatch,
    engineAvailable,
    engineSearched: report.engine.searched,
    engineOk: report.engine.ok,
  };
  report.status = fail > 0 ? "fail" : "pass";

  // 落盘报告（tests/reports 依 .gitignore 忽略，属产物）
  try {
    mkdirSync(REPORT_DIR, { recursive: true });
    await import("node:fs/promises").then((fs) =>
      fs.writeFile(join(REPORT_DIR, "real-link-smoke.json"), JSON.stringify(report, null, 2)),
    );
    console.log("\n报告已写:", join(REPORT_DIR, "real-link-smoke.json"));
  } catch (e) {
    console.error("报告写盘失败（非致命）:", e?.message || e);
  }

  return { report, code: fail > 0 ? 1 : 0 };
}

main()
  .then(({ report, code }) => {
    console.log(`\n结果: ${pass} 通过 / ${fail} 失败 — 状态: ${report.status}`);
    if (fail) console.log("失败项:", fails);
    if (FORCE_JSON) console.log(JSON.stringify(report, null, 2));
    process.exit(code);
  })
  .catch((e) => {
    // 显式错误捕获：任何未预期异常 → 视为真实链路故障（非静默吞没）
    console.error("\n[真实链路冒烟] 未预期异常，判定为故障:", e?.stack || e);
    process.exit(1);
  });
