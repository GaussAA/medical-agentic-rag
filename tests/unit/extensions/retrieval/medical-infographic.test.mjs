// medical-infographic-test.mjs
// retrieval.medical-infographic.ts 单测 —— 纯函数 + execute 错误路径。
// 运行: node --experimental-strip-types tests/unit/medical-infographic-test.mjs

import { buildPrompt, extractImageUrl, getApiKey } from "../../../../.pi/extensions/retrieval.medical-infographic.ts";

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.error("  ✗", name, detail); }
}

console.log("\n=== medical-infographic 单测 ===\n");

// ─────────────────────────────────────────────
console.log("[1] buildPrompt — 五种风格");
{
  const topic = "糖尿病酮症酸中毒急救步骤";
  const guideTitle = "中国糖尿病防治指南（2024版）";

  const pFlow = buildPrompt(topic, "flowchart", guideTitle);
  ok(pFlow.includes("流程图"), "flowchart → 流程图");
  ok(pFlow.includes(topic), "包含 topic");

  const pComp = buildPrompt(topic, "comparison", guideTitle);
  ok(pComp.includes("对比图"), "comparison → 对比图");

  const pSteps = buildPrompt(topic, "steps", guideTitle);
  ok(pSteps.includes("步骤图"), "steps → 步骤图");

  const pInfo = buildPrompt(topic, "infographic", guideTitle);
  ok(pInfo.includes("综合信息图"), "infographic → 综合信息图");

  const pAuto = buildPrompt(topic, "auto", guideTitle);
  ok(!pAuto.includes("（风格："), "auto → 不附加风格说明");
}

// ─────────────────────────────────────────────
console.log("\n[2] buildPrompt — 无 guideTitle");
{
  const p = buildPrompt("高血压药物分类", "comparison", "");
  ok(p.includes("对比图"), "无 guideTitle 仍正常");
  ok(!p.includes("参考指南："), "不含参考指南行");
}

// ─────────────────────────────────────────────
console.log("\n[3] extractImageUrl — data[0].url");
{
  const r = extractImageUrl({ data: [{ url: "https://img.example.com/a.png" }] });
  ok(r === "https://img.example.com/a.png", "data[0].url 提取");
}

// ─────────────────────────────────────────────
console.log("\n[4] extractImageUrl — images[0].url（兼容旧格式）");
{
  const r = extractImageUrl({ images: [{ url: "https://img.example.com/b.png" }] });
  ok(r === "https://img.example.com/b.png", "images[0].url 提取");
}

// ─────────────────────────────────────────────
console.log("\n[5] extractImageUrl — 空/缺省");
{
  ok(extractImageUrl({}) === null, "空对象 → null");
  ok(extractImageUrl(null) === null, "null → null");
  ok(extractImageUrl({ data: [] }) === null, "空 data 数组 → null");
}

// ─────────────────────────────────────────────
console.log("\n[6] getApiKey — 单 Key vs Key 池");
{
  // 先备份
  const prevSingle = process.env.SENSENOVA_API_KEY;
  const prevPool = process.env.SENSENOVA_API_KEYS;

  delete process.env.SENSENOVA_API_KEY;
  delete process.env.SENSENOVA_API_KEYS;
  ok(getApiKey() === "", "无 Key → 空字符串");

  process.env.SENSENOVA_API_KEY = "sk-test-single";
  ok(getApiKey() === "sk-test-single", "单 Key 优先");

  process.env.SENSENOVA_API_KEYS = "sk-pool-1,sk-pool-2";
  ok(getApiKey() === "sk-test-single", "单 Key 仍优先于池");

  delete process.env.SENSENOVA_API_KEY;
  ok(getApiKey() === "sk-pool-1", "无单 Key → 取池第一个");

  // 恢复
  if (prevSingle) process.env.SENSENOVA_API_KEY = prevSingle;
  if (prevPool) process.env.SENSENOVA_API_KEYS = prevPool;
}

// ─────────────────────────────────────────────
// execute 错误路径（mock fetch + mock pi）
console.log("\n[7] execute — 缺失 topic");
{
  const registered = {};
  const mockPi = { registerTool: (spec) => { registered[spec.name] = spec; } };
  const factory = (await import("../../../../.pi/extensions/retrieval.medical-infographic.ts")).default;
  await factory(mockPi);

  const r = await registered.generate_medical_infographic.execute("t1", {});
  ok(r.content[0].text.includes("缺少主题"), "缺 topic → 提示消息");
}

// ─────────────────────────────────────────────
console.log("\n[8] execute — 缺失 API Key（无 env）");
{
  const registered = {};
  const mockPi = { registerTool: (spec) => { registered[spec.name] = spec; } };
  const factory = (await import("../../../../.pi/extensions/retrieval.medical-infographic.ts")).default;
  await factory(mockPi);

  const prev = process.env.SENSENOVA_API_KEY;
  delete process.env.SENSENOVA_API_KEY;
  const prevPool = process.env.SENSENOVA_API_KEYS;
  delete process.env.SENSENOVA_API_KEYS;

  const r = await registered.generate_medical_infographic.execute("t1", { topic: "测试" });
  ok(r.content[0].text.includes("未找到"), "无 Key → 提示消息");

  if (prev) process.env.SENSENOVA_API_KEY = prev;
  if (prevPool) process.env.SENSENOVA_API_KEYS = prevPool;
}

// ─────────────────────────────────────────────
console.log("\n[9] execute — fetch 失败被 catch");
{
  const registered = {};
  const mockPi = { registerTool: (spec) => { registered[spec.name] = spec; } };
  const factory = (await import("../../../../.pi/extensions/retrieval.medical-infographic.ts")).default;
  await factory(mockPi);

  const prev = process.env.SENSENOVA_API_KEY;
  process.env.SENSENOVA_API_KEY = "sk-test";

  // Mock fetch to reject
  const origFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error("网络错误"); };

  const r = await registered.generate_medical_infographic.execute("t1", { topic: "测试" });
  ok(r.content[0].text.includes("信息图生成失败"), "fetch 异常 → 被 catch");
  ok(r.content[0].text.includes("网络错误"), "错误信息有传递"); // 返回了 msg

  globalThis.fetch = origFetch;
  if (prev) process.env.SENSENOVA_API_KEY = prev;
}

// ─────────────────────────────────────────────
console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
