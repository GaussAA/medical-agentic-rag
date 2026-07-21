// extract-entities-test.mjs
// P1#7 单测 —— parseKeys 纯函数（零 Key、零网络、零 DB）。
// 直接 import scripts/lib/parse-keys.mjs（无模块级副作用），不触碰 extract-entities.mjs 的 main()。
// 运行: node tests/unit/extract-entities-test.mjs

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // tests/unit
const MOD = pathToFileURL(join(HERE, "..", "..", "..", "scripts", "lib", "parse-keys.mjs")).href;
const { parseKeys } = await import(MOD);

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; fails.push(name + (extra ? " :: " + extra : "")); console.error("  ✗", name, extra); }
}

console.log("\n=== P1#7 extract-entities · parseKeys 单测 ===\n");

// 1) 空值安全
ok("null → []", JSON.stringify(parseKeys(null)) === "[]");
ok("undefined → []", JSON.stringify(parseKeys(undefined)) === "[]");
ok("空串 → []", JSON.stringify(parseKeys("")) === "[]");
ok("纯空白 → []", JSON.stringify(parseKeys("   \n\t ")) === "[]");

// 2) 逗号分隔
ok("逗号分隔 → 2 项", JSON.stringify(parseKeys("a,b")) === JSON.stringify(["a", "b"]));
ok("逗号+空格 → 去空白", JSON.stringify(parseKeys("a, b ,c")) === JSON.stringify(["a", "b", "c"]));

// 3) 空白 / 换行分隔
ok("空格分隔 → 3 项", JSON.stringify(parseKeys("k1 k2 k3")) === JSON.stringify(["k1", "k2", "k3"]));
ok("换行分隔 → 2 项", JSON.stringify(parseKeys("x\ny")) === JSON.stringify(["x", "y"]));

// 4) 混合 + 去空
const mixed = " k1, k2  k3\nk4 ,, k5 ";
ok(
  "混合分隔+去空+去空白",
  JSON.stringify(parseKeys(mixed)) === JSON.stringify(["k1", "k2", "k3", "k4", "k5"]),
);

// 5) 连续分隔符不产生空串
ok("连续逗号不产生空项", !parseKeys("a,,b,").includes(""));

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
