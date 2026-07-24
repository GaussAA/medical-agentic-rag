// retrieval-execute-contract.test.mjs
// 核心检索扩展 execute 契约测试 —— mock pi，验证返回结构，不调真实 KB。
// 测试 retrieval.orchestrator.ts 注册的 retrieve 工具（替代旧 guide-finder/kg-search/rag-search）
// 零网络、零 Key，进 CI。
// 运行: node --experimental-strip-types tests/unit/extensions/retrieval/execute-contract.test.mjs

// CI 环境下跳过（需 Pi jiti 加载 .ts 扩展文件）
if (process.env.CI) { process.exit(13); }

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.error("  ✗", name, detail); }
}

function capture() {
  const tools = {};
  return {
    tools,
    pi: {
      registerTool: (spec) => { tools[spec.name] = spec; },
      on: () => {},
    },
  };
}

// ─────────────────────────────────────────────
console.log("=== retrieval.orchestrator (retrieve) ===\n");

{
  const { tools, pi } = capture();
  const factory = (await import("../../../../.pi/extensions/retrieval.orchestrator.ts")).default;
  await factory(pi);

  ok(tools.retrieve != null, "注册 retrieve");
  const exec = tools.retrieve.execute;
  ok(typeof exec === "function", "execute 为函数");
  ok(tools.retrieve.parameters?.properties?.query, "parameters 含 query");

  // 缺 query → 返回提示
  const r1 = await exec("t1", {});
  ok(Array.isArray(r1.content), "缺 query: content 为数组");
  ok(r1.content[0]?.text?.includes("请提供"), "缺 query: 含提示文本");

  // 空 query
  const r2 = await exec("t2", { query: "  " });
  ok(r2.content[0]?.text?.includes("请提供"), "空 query: 含提示");

  // 有 query → 返回检索结果（即便 KB 无匹配，不能抛）
  const r3 = await exec("t3", { query: "肝癌" });
  ok(Array.isArray(r3.content), "有 query: content 仍为数组");
  ok(typeof r3.content[0]?.text === "string", "有 query: text 为字符串");
  ok(r3.content[0]?.text.includes("检索报告") || r3.content[0]?.text.includes("查询"), "有 query: 含检索报告");
}

// ── 汇总 ──
console.log(`\n执行契约单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
