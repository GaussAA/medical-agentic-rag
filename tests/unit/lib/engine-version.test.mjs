// engine-version-test.mjs
// 引擎依赖版本探测单测（纯函数，零 IO 依赖，CI 可跑）。
// 运行: node tests/unit/engine-version-test.mjs
//
// 覆盖 #33 增强：路径环境变量化推导 + API 面版本探测断言 + 版本号读取。

import {
  npmRoots,
  candidates,
  validateEngineApi,
  getEngineVersion,
} from "../../../.pi/extensions/lib/knowledge-engine-search.mjs";

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

console.log("\n[1] npmRoots / candidates — 环境变量化路径推导");
{
  const norm = (s) => s.replace(/\\/g, "/"); // 斜杠无关比对（Windows 用反斜杠）
  const prev = process.env.PI_AGENT_NPM;
  delete process.env.PI_AGENT_NPM;
  const roots = npmRoots();
  ok("USERPROFILE 派生 .pi/agent/npm 路径", roots.some((r) => norm(r).includes(".pi/agent/npm")), JSON.stringify(roots));
  const cs = candidates("engine.js").map(norm);
  ok("candidates 含 dist/src 与 dist 双布局（版本探测）",
    cs.some((c) => c.includes("dist/src/engine.js")) &&
    cs.some((c) => c.includes("dist/engine.js")));
  process.env.PI_AGENT_NPM = "/tmp/fake-npm";
  ok("PI_AGENT_NPM 优先纳入", npmRoots().includes("/tmp/fake-npm"));
  if (prev === undefined) delete process.env.PI_AGENT_NPM;
  else process.env.PI_AGENT_NPM = prev;
}

console.log("\n[2] validateEngineApi — 版本探测断言");
{
  function ValidEngine() {}
  ValidEngine.prototype.search = function () {};
  ValidEngine.prototype.initialize = function () {};
  ok("合法 API 面（构造器+search+initialize）通过", validateEngineApi({ KnowledgeEngine: ValidEngine }) === true);

  let threwConstructor = false;
  try { validateEngineApi({}); } catch (e) { threwConstructor = /KnowledgeEngine/.test(e.message); }
  ok("缺失 KnowledgeEngine 构造器→抛清晰错误", threwConstructor);

  function NoSearch() {}
  let threwSearch = false;
  try { validateEngineApi({ KnowledgeEngine: NoSearch }); } catch (e) { threwSearch = /search/.test(e.message); }
  ok("缺失 search 方法→抛清晰错误", threwSearch);
}

console.log("\n[3] getEngineVersion — 读取已装版本（无则 null，不抛）");
{
  let v = null;
  let threw = false;
  try { v = getEngineVersion(); } catch { threw = true; }
  ok("不抛异常", !threw);
  ok("返回 版本号字符串 或 null", v === null || typeof v === "string", String(v));
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) console.log("失败项:", fails);
process.exit(fail ? 1 : 0);
