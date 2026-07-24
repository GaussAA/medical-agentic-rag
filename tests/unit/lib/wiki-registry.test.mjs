/**
 * wiki-registry.test.mjs — retrieval.orchestrator.ts 中 wiki 注册表
 * 查询函数（queryWikiRegistry）的纯函数单测。
 *
 * 直接从 orchestrator.ts 摘取并导出 queryWikiRegistry，用模拟注册表数据验证
 * 中文 n-gram 匹配逻辑的正确性。
 *
 * 运行：node --experimental-strip-types tests/unit/lib/wiki-registry.test.mjs
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ── Mock 注册表 ──
const MOCK_REGISTRY = {
  version: "1.0",
  last_updated: "2026-07-24",
  pages: {
    "entities/helicobacter-pylori": {
      type: "entity",
      title: "helicobacter-pylori",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "entities/hp": {
      type: "entity",
      title: "hp",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "entities/hypertension": {
      type: "entity",
      title: "hypertension",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "concepts/dual-antiplatelet-therapy": {
      type: "concept",
      title: "Dual Antiplatelet Therapy (DAPT)",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "analyses/eval-Q16-哪些情况推荐根除幽门螺杆菌": {
      type: "analysis",
      title: "eval-Q16-哪些情况推荐根除幽门螺杆菌",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "analyses/eval-Q30-幽门螺杆菌感染现在一般怎么根除": {
      type: "analysis",
      title: "eval-Q30-幽门螺杆菌感染现在一般怎么根除",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "analyses/eval-Q08-高血压降压治疗的目标与原则": {
      type: "analysis",
      title: "eval-Q08-高血压降压治疗的目标与原则",
      created: "2026-07-24",
      updated: "2026-07-24",
      sources: [],
    },
    "sources/SRC-2026-07-24-001": {
      type: "source",
      title: "SRC-2026-07-24-001",
      created: "2026-07-24",
      updated: "2026-07-24",
      source_id: "SRC-2026-07-24-001",
    },
  },
};

// ── 从 orchestrator 复制 queryWikiRegistry（纯函数，无外部依赖）──
function queryWikiRegistry(registry, query) {
  const matchedPages = [];
  const queryLower = query.toLowerCase();

  // 中文 n-gram 全子串检索
  const tokenCandidates = new Set();
  tokenCandidates.add(queryLower);
  const tokens = queryLower.split(/[\s,，、；;。.：:！!?？（）()《》<>"']+/).filter(Boolean);
  for (const t of tokens) {
    tokenCandidates.add(t);
    for (let i = 0; i < t.length - 1; i++) {
      for (let j = i + 2; j <= Math.min(i + 8, t.length); j++) {
        tokenCandidates.add(t.slice(i, j));
      }
    }
  }

  for (const [slug, entry] of Object.entries(registry.pages)) {
    if (entry.type === "source") continue;
    const title = (entry.title || "").toLowerCase();
    const slugLower = slug.toLowerCase();

    for (const tc of tokenCandidates) {
      if (tc.length >= 2 && (title.includes(tc) || slugLower.includes(tc))) {
        matchedPages.push(slug);
        break;
      }
    }
  }

  return matchedPages;
}

// ── 测试框架 ──
let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name); console.error("  ✗", name, detail); }
}

// ── 测试用例 ──

// [1] 完全匹配中文实体名
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "幽门螺杆菌");
  ok(r.includes("analyses/eval-Q16-哪些情况推荐根除幽门螺杆菌"),
    "完全匹配中文标题");
  ok(r.includes("analyses/eval-Q30-幽门螺杆菌感染现在一般怎么根除"),
    "完全匹配中文标题2");
  ok(r.length >= 2, "命中至少 2 条");
}

// [2] 长查询 n-gram 子串匹配（"幽门螺杆菌治疗方案"→匹配"幽门螺杆菌"）
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "幽门螺杆菌治疗方案");
  ok(r.includes("analyses/eval-Q30-幽门螺杆菌感染现在一般怎么根除"),
    "长查询 n-gram 匹配幽门螺杆菌");
  ok(r.length >= 1, "至少 1 条命中");
}

// [3] 英文实体名匹配
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "helicobacter pylori treatment");
  ok(r.includes("entities/helicobacter-pylori"),
    "英文实体名匹配");
}

// [4] 中文+英文混合查询
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "高血压 hypertension");
  ok(r.includes("analyses/eval-Q08-高血压降压治疗的目标与原则"),
    "中文+英文混合命中分析页");
}

// [5] source 类型不纳入搜索结果
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "SRC-2026-07-24-001");
  ok(!r.includes("sources/SRC-2026-07-24-001"),
    "source 类型页面不纳入搜索结果");
}

// [6] 无匹配返回空
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "不存在的疾病名称");
  ok(r.length === 0, "无匹配返回空数组");
}

// [7] 空查询返回空
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "");
  ok(r.length === 0, "空查询返回空数组");
}

// [8] 短查询（2字）应用 n-gram 匹配
{
  const r = queryWikiRegistry(MOCK_REGISTRY, "降压");
  ok(r.includes("analyses/eval-Q08-高血压降压治疗的目标与原则"),
    "2字短查询 n-gram 匹配");
}

// ── 汇总 ──
console.log(`\nwiki-registry 单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
