// knowledge-engine-search-test.mjs
// 适配器单测：复用内置 KnowledgeEngine 的「真 hybrid + 重排」（Opt2）。
// 设计纪律（契合项目原则）：
//   · 无静默失败：engineHybridSearch 永不抛出，引擎不可用/检索失败一律返回 {ok:false, error}。
//   · 双可测：纯 .mjs，原生 node 直接跑；引擎不可用时 live 部分整体跳过（CI 隔离，符合预期）。
//   · 错误路径契约与 live 检索契约分离：前者始终校验，后者仅在本地有 pi-knowledge 时生效。
// 运行: node tests/unit/knowledge-engine-search-test.mjs
// 依赖: 本地需 pi-knowledge@0.5.1 已安装于 ~/.pi/agent/npm 才会执行 live 断言；CI 仅校验错误路径。

import { existsSync } from "node:fs";
import { join } from "node:path";
import { engineHybridSearch, isEngineAvailable, applySoftConstraint, searchWithTimeout } from "../../../.pi/extensions/lib/knowledge-engine-search.mjs";

// 同步预判：内置引擎是否可达（避免 live 段 await 后才发现不可用）
const ENGINE_AVAILABLE = (() => {
  const cand = [
    (process.env.PI_AGENT_NPM || join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm")) + "/node_modules/pi-knowledge/dist/src/engine.js",
    (process.env.USERPROFILE || process.env.HOME || "") + "/.pi/agent/npm/node_modules/pi-knowledge/dist/src/engine.js",
  ];
  return cand.some((p) => existsSync(p));
})();

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    fails.push(name + (extra ? " :: " + extra : ""));
    console.log("  ✗", name, extra);
  }
}

// ─────────────────────────────────────────────
console.log("\n[0] 错误路径契约 — engineHybridSearch 永不抛出（无静默失败）");
{
  let threw = false;
  let res = null;
  try {
    res = await engineHybridSearch("糖尿病 血糖 管理", { limit: 3 });
  } catch (e) {
    threw = true;
    fails.push("engineHybridSearch 抛出异常: " + e.message);
  }
  ok("调用不抛异常", !threw);
  ok("返回对象含 ok 布尔字段", res && typeof res.ok === "boolean");
  if (res && res.ok) {
    ok("成功时 results 为数组", Array.isArray(res.results));
  } else if (res) {
    ok("失败时 error 为字符串（显式原因，非静默）", typeof res.error === "string" && res.error.length > 0, JSON.stringify(res));
  }

  // isEngineAvailable 亦不得抛
  let availThrew = false;
  let avail = false;
  try {
    avail = await isEngineAvailable();
  } catch (e) {
    availThrew = true;
    fails.push("isEngineAvailable 抛出异常: " + e.message);
  }
  ok("isEngineAvailable 不抛异常", !availThrew);
  ok("isEngineAvailable 返回布尔", typeof avail === "boolean");
}

// ─────────────────────────────────────────────
console.log("\n[0.5a] 软约束兜底纯函数 applySoftConstraint（P0-2，无需真引擎）");
{
  const R = (fp, score) => ({ file_path: fp, score });
  const full = [R("hcc.md", 30), R("dm.md", 20), R("flu.md", 5)];

  // 无路由 → 原样返回，不采信约束
  const a = applySoftConstraint(full, null);
  ok("无路由 → 原样返回", a.results.length === 3 && a.constraintApplied === false);

  // 空结果 → 返回空，不崩
  const b = applySoftConstraint([], ["hcc.md"]);
  ok("空结果 → 返回空且 constraintApplied=false", Array.isArray(b.results) && b.results.length === 0 && b.constraintApplied === false);

  // 约束到不存在文件 → 过滤集空 → 回退全库（根治 P0-2 硬过滤砍空）
  const c = applySoftConstraint(full, ["不存在.md"]);
  ok("约束到不存在文件 → 回退全库(非空)", c.results.length === 3 && c.constraintApplied === false);

  // 约束到高分文件（=全库 top）→ 采信过滤集
  const d = applySoftConstraint(full, ["hcc.md"]);
  ok("约束到高分文件 → 采信过滤集(仅该文件)", d.constraintApplied === true && d.results.every((r) => r.file_path === "hcc.md"));

  // 约束到低分文件（5 < 30×0.6=18）→ 判定路由失准 → 回退全库
  const e = applySoftConstraint(full, ["flu.md"]);
  ok("约束到低分文件(远低于全库top) → 回退全库", e.constraintApplied === false && e.results.length === 3);

  // 约束到次高分文件（20 ≥ 30×0.6=18）→ 采信（仍在可信区间）
  const f = applySoftConstraint(full, ["dm.md"]);
  ok("约束到次高分文件(≥全库top×ratio) → 采信过滤集", f.constraintApplied === true && f.results.every((r) => r.file_path === "dm.md"));

  // fullTop<=0 退化保护 → 采信过滤集
  const g = applySoftConstraint([R("x.md", 0), R("y.md", 0)], ["x.md"]);
  ok("全库无有效分数(退化) → 保守采信过滤集", g.constraintApplied === true && g.results.every((r) => r.file_path === "x.md"));

  // 自定义 ratio：ratio=0.1 时低分文件也采信
  const h = applySoftConstraint(full, ["flu.md"], { ratio: 0.1 });
  ok("自定义 ratio=0.1 → 低分文件亦采信", h.constraintApplied === true && h.results.every((r) => r.file_path === "flu.md"));
}

console.log("\n[0.5b] 超时熔断纯函数 searchWithTimeout（P0-3，mock 引擎）");
{
  // 快引擎：立即返回 → 正常透传结果
  const fastEngine = { search: async () => ({ results: [{ file_path: "a.md", score: 1 }], mode_used: "hybrid", total_count: 1 }) };
  let fastResp = null, fastThrew = false;
  try {
    fastResp = await searchWithTimeout(fastEngine, "q", { mode: "hybrid" }, null, 1000);
  } catch { fastThrew = true; }
  ok("快引擎 → 正常返回结果(不超时)", !fastThrew && fastResp && Array.isArray(fastResp.results) && fastResp.results.length === 1);

  // 慢引擎：5s 延迟，timeout=50ms → 抛 ENGINE_TIMEOUT
  const slowEngine = {
    search: (_q, _o, _sig) => new Promise((res) => { const t = setTimeout(() => res({ results: [] }), 5000); if (t.unref) t.unref(); }),
  };
  const tStart = Date.now();
  let slowErr = null;
  try {
    await searchWithTimeout(slowEngine, "q", { mode: "hybrid" }, null, 50);
  } catch (e) { slowErr = e; }
  const elapsed = Date.now() - tStart;
  ok("慢引擎 → 抛 ENGINE_TIMEOUT", slowErr && slowErr.message === "ENGINE_TIMEOUT", "err=" + (slowErr && slowErr.message));
  ok("慢引擎 → 熔断秒回(远早于5s)", elapsed < 1000, "elapsed=" + elapsed + "ms");

  // 合并外部 signal：搜索仍可正常完成（signal 未 abort）
  const ac = new AbortController();
  let mergedResp = null, mergedThrew = false;
  try {
    mergedResp = await searchWithTimeout(fastEngine, "q", { mode: "hybrid" }, ac.signal, 1000);
  } catch { mergedThrew = true; }
  ok("合并外部 signal(未abort) → 正常返回", !mergedThrew && mergedResp && Array.isArray(mergedResp.results));
}

// ─────────────────────────────────────────────
if (!ENGINE_AVAILABLE) {
  console.log("\n  (跳过 live 检索断言：内置引擎不可用 — CI 隔离环境，符合预期；错误路径契约已校验)");
} else {
  console.log("\n[1] hybrid 模式 — live 检索契约");
  const r = await engineHybridSearch("原发性肝癌 高危人群 筛查", { mode: "hybrid", limit: 5 });
  ok("hybrid 返回 ok:true", r.ok === true, r.error || "");
  ok("hybrid 返回非空 results 数组", r.ok && Array.isArray(r.results) && r.results.length > 0, "len=" + (r.results?.length));
  ok("结果含 file_path(非空字符串)", r.ok && r.results.every((x) => typeof x.file_path === "string" && x.file_path.length > 0));
  ok("结果含数值 score(已四舍五入)", r.ok && r.results.every((x) => typeof x.score === "number" && !Number.isNaN(x.score)));
  ok("结果含 chunk_id(供引文锚定; 允许 null)", r.ok && r.results.every((x) => x.chunk_id === null || typeof x.chunk_id === "string"));
  ok("结果含 snippet 文本", r.ok && r.results.every((x) => typeof x.snippet === "string"));
  ok("totalCount 为正数字", r.ok && typeof r.totalCount === "number" && r.totalCount > 0, "tc=" + r.totalCount);
  ok("latencyMs 为非负数字", r.ok && typeof r.latencyMs === "number" && r.latencyMs >= 0, "ms=" + r.latencyMs);
  ok("modeUsed 回传 hybrid", r.ok && r.modeUsed === "hybrid", "modeUsed=" + r.modeUsed);

  // ── 抽取真实 file_path 供后续约束测试（保证约束目标确在 KB 中）──
  const target = r.ok ? r.results[0].file_path : null;

  console.log("\n[2] semantic 模式 — 复用已加载 e5（秒级）");
  const s = await engineHybridSearch("2型糖尿病 二甲双胍 一线治疗", { mode: "semantic", limit: 5 });
  ok("semantic 返回 ok:true", s.ok === true, s.error || "");
  ok("semantic 结果含 chunk_id", s.ok && s.results.length > 0 && s.results.every((x) => x.chunk_id), "res=" + (s.results?.[0]?.chunk_id));

  console.log("\n[3] 软约束兜底契约 — routedFilePaths 采信/回退（P0-2）");
  if (target) {
    const c = await engineHybridSearch("原发性肝癌 高危人群 筛查", {
      mode: "hybrid",
      limit: 5,
      routedFilePaths: [target],
    });
    // 约束到真实 top1 文件（分数=全库top）→ 采信过滤集，结果全为该文件
    ok("约束到真实 top1 文件 → 采信且全为该文件", c.ok && c.results.length > 0 && c.constraintApplied === true && c.results.every((x) => x.file_path === target), JSON.stringify(c.results.map((x) => x.file_path)));
  } else {
    console.log("  (跳过：无可用 target，约束测试依赖 [1] 命中)");
  }

  // 软约束兜底(P0-2)：约束到不存在文件 → 过滤集空 → 回退全库（不再返回空，根治路由失准砍空）
  const off = await engineHybridSearch("原发性肝癌 高危人群 筛查", {
    mode: "hybrid",
    limit: 5,
    routedFilePaths: ["zzz_无关文件_不存在.md"],
  });
  ok("约束到无关文件 → 回退全库非空(软约束兜底)", off.ok && off.results.length > 0, "len=" + off.results.length);
  ok("约束到无关文件 → constraintApplied=false(未采信约束)", off.ok && off.constraintApplied === false, "ca=" + off.constraintApplied);

  // ── deep 模式(重排) 默认跳过：cross-encoder 首次加载 ~11s；置 RUN_DEEP_ENGINE_TEST=1 开启 ──
  if (process.env.RUN_DEEP_ENGINE_TEST === "1") {
    console.log("\n[4] deep 模式(重排) — 跨编码器");
    const d = await engineHybridSearch("原发性肝癌 高危人群 筛查", { mode: "deep", limit: 5 });
    ok("deep 返回 ok:true", d.ok === true, d.error || "");
    ok("deep 结果含 chunk_id", d.ok && d.results.length > 0 && d.results.every((x) => x.chunk_id));
  }
}

// ─────────────────────────────────────────────
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  -", f);
  process.exit(1);
}
// 显式成功退出码：e5 引擎(transformers.js)会残留后台 worker/句柄，
// 自然退出可能把 exitCode 置 1（引擎清理副作用，非断言失败），此处强制 0 固化门禁判定。
process.exit(0);
