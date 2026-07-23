// retrieval-execute-contract.test.mjs
// 核心检索扩展 execute 契约测试 —— mock pi，验证返回结构，不调真实 KB。
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
console.log("=== retrieval.guide-finder ===\n");

{
  const { tools, pi } = capture();
  const factory = (await import("../../../../.pi/extensions/retrieval.guide-finder.ts")).default;
  await factory(pi);

  ok(tools.guide_finder != null, "注册 guide_finder");
  const exec = tools.guide_finder.execute;
  ok(typeof exec === "function", "execute 为函数");
  ok(tools.guide_finder.parameters?.properties?.query, "parameters 含 query");

  // 缺 query → 返回提示
  const r1 = await exec("t1", {});
  ok(Array.isArray(r1.content), "缺 query: content 为数组");
  ok(r1.content[0]?.text?.includes("请提供"), "缺 query: 含提示文本");

  // 空 query
  const r2 = await exec("t2", { query: "  " });
  ok(r2.content[0]?.text?.includes("请提供"), "空 query: 含提示");

  // 有 query → 返回 route 结果（即便 KB 无匹配，不能抛）
  const r3 = await exec("t3", { query: "肝癌" });
  ok(Array.isArray(r3.content), "有 query: content 仍为数组");
  ok(typeof r3.content[0]?.text === "string", "有 query: text 为字符串");
}

// ─────────────────────────────────────────────
console.log("\n=== retrieval.kg-search-tool ===\n");

{
  const { tools, pi } = capture();
  const factory = (await import("../../../../.pi/extensions/retrieval.kg-search-tool.ts")).default;
  await factory(pi);

  ok(tools.kg_search != null, "注册 kg_search");
  const exec = tools.kg_search.execute;
  ok(typeof exec === "function", "execute 为函数");
  ok(tools.kg_search.parameters?.properties?.disease, "parameters 含 disease");

  // 缺 disease → 返回 KG 结果（空参数不走验证路径，不抛）
  const r1 = await exec("t1", {});
  ok(Array.isArray(r1.content), "缺 disease: content 为数组");

  // 有 disease → 返回 KG 结果（无 KG DB 时优雅降级，不抛）
  const r2 = await exec("t2", { disease: "肝癌" });
  ok(Array.isArray(r2.content), "有 query: content 仍为数组");
  ok(typeof r2.content[0]?.text === "string", "有 query: text 为字符串");
}

// ─────────────────────────────────────────────
console.log("\n=== retrieval.rag-search ===\n");

{
  const { tools, pi } = capture();
  const factory = (await import("../../../../.pi/extensions/retrieval.rag-search.ts")).default;
  await factory(pi);

  ok(tools.rag_search != null, "注册 rag_search");
  const exec = tools.rag_search.execute;
  ok(typeof exec === "function", "execute 为函数");
  const props = tools.rag_search.parameters?.properties;
  ok(props?.query, "parameters 含 query");

  // 缺 query → 返回提示
  const r1 = await exec("t1", {});
  ok(Array.isArray(r1.content), "缺 query: content 为数组");
  ok(r1.content[0]?.text?.includes("检索"), "缺 query: 含提示");

  // 有 query → 返回检索结果（无 KB 时优雅降级）
  const r2 = await exec("t2", { query: "高血压" });
  ok(Array.isArray(r2.content), "有 query: content 仍为数组");

  // 带 mode 参数
  const r3 = await exec("t3", { query: "糖尿病", mode: "deep" });
  ok(Array.isArray(r3.content), "带 mode: content 为数组");

  // 无效 mode 不崩溃
  const r4 = await exec("t4", { query: "糖尿病", mode: "invalid" });
  ok(Array.isArray(r4.content), "无效 mode: 不崩溃");
}

// ─────────────────────────────────────────────
console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
