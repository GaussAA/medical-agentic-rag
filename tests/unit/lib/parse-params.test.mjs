// parse-params-test.mjs
// lib/parse-params.mjs 单测 —— 参数归一化所有分支。
// 纯函数，零依赖，零网络，进 CI。
// 运行: node tests/unit/parse-params-test.mjs

import { normalizeParams } from "../../../.pi/extensions/lib/parse-params.mjs";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.error("  ✗", name, detail); }
}

console.log("\n=== parse-params 单测 ===\n");

// 1. 直接对象
{
  const r = normalizeParams({ query: "高血压", limit: 5 });
  ok(r.query === "高血压", "直接对象 → query 保留");
  ok(r.limit === 5, "直接对象 → limit 保留");
}

// 2. JSON 字符串
{
  const r = normalizeParams('{"query":"糖尿病","limit":3}');
  ok(r.query === "糖尿病", "JSON 字符串 → 解析");
  ok(r.limit === 3, "JSON 字符串 → 数字保留");
}

// 3. 嵌套 { arguments: "JSON字符串" }
{
  const r = normalizeParams({ arguments: '{"query":"肺癌"}' });
  ok(r.query === "肺癌", "嵌套 arguments(字符串) → 解析");
}

// 4. 嵌套 { arguments: 对象 }
{
  const r = normalizeParams({ arguments: { query: "肝癌" } });
  ok(r.query === "肝癌", "嵌套 arguments(对象) → 展开");
}

// 5. null / undefined
{
  ok(Object.keys(normalizeParams(null)).length === 0, "null → 空对象");
  ok(Object.keys(normalizeParams(undefined)).length === 0, "undefined → 空对象");
}

// 6. 空字符串
{
  const r = normalizeParams("");
  ok(typeof r === "object" && !Array.isArray(r), "空字符串 → 空对象");
}

// 7. 非法 JSON 字符串 → 兜底空对象（不传播脏字符串）
{
  const r = normalizeParams("{invalid json}");
  ok(typeof r === "object" && Object.keys(r).length === 0, "非法 JSON → 兜底空对象");
}

// 8. 有 arguments 但 arguments 非法 JSON
{
  const r = normalizeParams({ arguments: "{nope}" });
  ok(typeof r === "object" && !r.query, "arguments 非法 JSON → 空对象");
}

// 9. 已解析的对象不受影响
{
  const input = { keyword: "骨质疏松", mode: "deep" };
  const r = normalizeParams(input);
  ok(r.keyword === "骨质疏松", "已解析对象 → keyword 保留");
  ok(r.mode === "deep", "已解析对象 → mode 保留");
  // 确保返回的是同一引用层面上的新对象（不修改原对象）
  ok(input.keyword === "骨质疏松", "原对象未被修改");
}

// 10. 数字 params
{
  const r = normalizeParams(42);
  ok(typeof r === "object" && Object.keys(r).length === 0, "数字 → 空对象");
}

// 11. 数组 params
{
  const r = normalizeParams(["a", "b"]);
  ok(typeof r === "object" && !Array.isArray(r) && Object.keys(r).length === 0, "数组 → 空对象");
}

console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
