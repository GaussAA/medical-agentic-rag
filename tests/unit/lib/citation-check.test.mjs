// citation-check-test.mjs
// P1#8 单测 —— resolveGtDisease 纯函数（用合成 guideMap/vocab，不依赖真实 KB 索引）。
// 直接 import scripts/eval/quality/citation-check.mjs（其模块级 loadIndex 仅读盘、无网络/exit 副作用）。
// 运行: node tests/unit/citation-check-test.mjs

import { pathToFileURL, fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url)); // tests/unit
const MOD = pathToFileURL(join(HERE, "..", "..", "..", "scripts", "eval", "quality", "citation-check.mjs")).href;
const { resolveGtDisease } = await import(MOD);

// 合成索引（不依赖真实 data/kb/.guide-index.json）
const guideMap = {
  "幽门螺杆菌诊治指南.pdf": { disease: "幽门螺杆菌" },
  "妊娠期高血糖诊治指南.pdf": { disease: "妊娠期高血糖" },
  "2型糖尿病防治指南.pdf": { disease: "糖尿病" },
};
const vocab = ["幽门螺杆菌", "妊娠期高血糖", "糖尿病", "慢阻肺"];

let passed = 0, failed = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) { passed++; console.log("  ✓", name); }
  else { failed++; fails.push(name + (extra ? " :: " + extra : "")); console.error("  ✗", name, extra); }
}

console.log("\n=== P1#8 citation-check · resolveGtDisease 单测 ===\n");

// 1) 指南键精确命中
ok("指南键精确命中 → 幽门螺杆菌", resolveGtDisease("幽门螺杆菌诊治指南.pdf", guideMap, vocab) === "幽门螺杆菌");
ok("指南键精确命中 → 妊娠期高血糖", resolveGtDisease("妊娠期高血糖诊治指南.pdf", guideMap, vocab) === "妊娠期高血糖");

// 2) 归一别名（含疾病名子串即命中 vocab）
ok("含『糖尿病』归一 → 糖尿病", resolveGtDisease("某某2型糖尿病诊疗规范", guideMap, vocab) === "糖尿病");
ok("含『幽门螺杆菌』归一 → 幽门螺杆菌", resolveGtDisease("儿童幽门螺杆菌感染处理", guideMap, vocab) === "幽门螺杆菌");
ok("含『妊娠期高血糖』归一 → 妊娠期高血糖", resolveGtDisease("围产产期妊娠期高血糖膳食", guideMap, vocab) === "妊娠期高血糖");

// 3) 空值 / 未命中
ok("空串 gt → null", resolveGtDisease("", guideMap, vocab) === null);
ok("null gt → null", resolveGtDisease(null, guideMap, vocab) === null);
ok("无匹配病种 → null", resolveGtDisease("与指南无关的随机问题", guideMap, vocab) === null);
ok("仅含通用词无病种 → null", resolveGtDisease("诊疗规范与共识", guideMap, vocab) === null);

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);
if (failed > 0) {
  console.error("失败项:");
  for (const f of fails) console.error("  -", f);
  process.exit(1);
}
process.exit(0);
