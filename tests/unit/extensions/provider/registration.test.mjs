// provider-registration-test.mjs
// provider.sensenova.ts / agnes.ts / local.ts 注册逻辑单测。
// mock pi 捕获 registerProvider 调用，验证配置完整性。
// 零网络/零 Key，进 CI。
// 运行: node --experimental-strip-types tests/unit/provider-registration-test.mjs

let pass = 0, fail = 0;
const fails = [];
function ok(cond, name, detail = "") {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name + (detail ? " :: " + detail : "")); console.error("  ✗", name, detail); }
}

function captureProvider() {
  const configs = {};
  return {
    configs,
    mockPi: {
      registerProvider: (name, cfg) => { configs[name] = cfg; },
    },
  };
}

console.log("\n=== Provider 注册单测 ===\n");

// ─────────────────────────────────────────────
console.log("[1] provider.sensenova.ts");
{
  const { configs, mockPi } = captureProvider();
  const factory = (await import("../../../../.pi/extensions/provider.sensenova.ts")).default;
  await factory(mockPi);

  const c = configs.sensenova;
  ok(c != null, "已注册 name=sensenova");
  ok(c.baseUrl === "https://token.sensenova.cn/v1", "baseUrl 正确");
  ok(c.apiKey === "$SENSENOVA_API_KEY", "apiKey 引用环境变量");
  ok(Array.isArray(c.models) && c.models.length === 2, "2 个模型");
  ok(c.models.some((m) => m.id === "sensenova-6.7-flash-lite"), "主力模型 sensenova-6.7-flash-lite");
  ok(c.models.some((m) => m.id === "deepseek-v4-flash"), "备用通道 deepseek-v4-flash");
  ok(c.models.every((m) => m.cost.input === 0 && m.cost.output === 0), "模型 cost 均为免费");
}

// ─────────────────────────────────────────────
console.log("\n[2] provider.agnes.ts");
{
  const { configs, mockPi } = captureProvider();
  const factory = (await import("../../../../.pi/extensions/provider.agnes.ts")).default;
  await factory(mockPi);

  const c = configs.agnes;
  ok(c != null, "已注册 name=agnes");
  ok(c.baseUrl === "https://apihub.agnes-ai.com/v1", "baseUrl 正确");
  ok(c.apiKey === "$AGNES_API_KEY", "apiKey 引用 AGNES_API_KEY");
  ok(Array.isArray(c.models) && c.models.length === 1, "1 个模型");
  ok(c.models[0].id === "agnes-2.0-flash", "模型 agnes-2.0-flash");
}

// ─────────────────────────────────────────────
console.log("\n[3] provider.local.ts");
{
  const { configs, mockPi } = captureProvider();
  const factory = (await import("../../../../.pi/extensions/provider.local.ts")).default;
  await factory(mockPi);

  const c = configs.local;
  ok(c != null, "已注册 name=local");
  ok(c.baseUrl === "http://localhost:1234/v1", "baseUrl 指向本地 LM Studio");
  ok(c.apiKey === "local-no-auth", "apiKey 为占位字符串");
  ok(Array.isArray(c.models) && c.models.length === 1, "1 个静态后备模型");
  ok(c.models[0].id === "google/gemma-4-e2b", "静态模型 gemma-4-e2b");
  ok(c.models[0].contextWindow === 32768, "contextWindow=32K");
  ok(typeof c.refreshModels === "function", "含 refreshModels 动态刷新函数");
}

// ─────────────────────────────────────────────
console.log("\n[4] 跨 provider 不冲突");
{
  const configs = {};
  const sharedPi = {
    registerProvider: (name, cfg) => {
      // 模拟 Pi 框架的实际行为：同 name 应覆盖
      configs[name] = cfg;
    },
  };
  const sensenova = (await import("../../../../.pi/extensions/provider.sensenova.ts")).default;
  const agnes = (await import("../../../../.pi/extensions/provider.agnes.ts")).default;
  const local = (await import("../../../../.pi/extensions/provider.local.ts")).default;
  await sensenova(sharedPi);
  await agnes(sharedPi);
  await local(sharedPi);

  ok(Object.keys(configs).length === 3, "3 个 provider 互不覆盖");
  ok(configs.sensenova?.models?.length === 2, "sensenova 2 模型");
  ok(configs.agnes?.models?.length === 1, "agnes 1 模型");
  ok(configs.local?.models?.length === 1, "local 1 模型");
}

console.log(`\n=== 结果 ===\n通过 ${pass} / ${pass + fail}`);
if (fail > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
