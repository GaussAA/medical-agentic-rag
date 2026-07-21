// tests/unit/multisource/normalize-test.mjs
// 内容归一化器纯函数单测。
import { decodeEntities, stripTags, cleanWhitespace, normalizeDoc, truncateSafe } from "../../../../../scripts/kb/multisource/lib/normalize.mjs";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

console.log("[normalize] 实体解码");
ok("&amp;→&", decodeEntities("A &amp; B") === "A & B");
ok("数值实体→字", decodeEntities("&#65;") === "A");

console.log("[normalize] 标签剥离");
ok("去 HTML 标签", stripTags("<p>心脏</p><div>血管</div>").includes("心脏") && !stripTags("<p>心脏</p>").includes("<"));
ok("保留中文层级", stripTags("<title>一、背景</title>").includes("一、背景"));

console.log("[normalize] 空白折叠");
ok("多空行→单", cleanWhitespace("a\n\n\n\nb") === "a\nb");

console.log("[normalize] 文档规范化");
const doc = normalizeDoc("<p>一、诊断</p><p>胸痛患者需评估。</p>", { title: "急性心梗诊治", source: "Europe PMC (OA)", license: "cc-by", url: "https://x", year: 2024 });
ok("含 # 标题", doc.startsWith("# 急性心梗诊治"));
ok("含溯源块(来源)", doc.includes("> 来源: Europe PMC (OA)"));
ok("含溯源块(许可)", doc.includes("> 许可: cc-by"));
ok("含中文层级", doc.includes("一、诊断"));
ok("无残留标签", !doc.includes("<p>"));

console.log("[normalize] 截断");
ok("超长截断", truncateSafe("x".repeat(600000), 100).length <= 200);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
