// tests/unit/chinese-heading-test.mjs
// 零副作用单测：直接 import 纯模块，不拉 Pi / 不碰 KB。
import { CN_DIGITS, SECTION_RE, isHeadingLine, countHeadings } from "../../../scripts/lib/chinese-heading.mjs";

let pass = 0, fail = 0;
function ok(cond, name) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("=== P1#5 chinese-heading · 统一中文标题正则 ===");

// 1) 中文数字集含「两」（ab 原缺失漂移点）
ok(CN_DIGITS.includes("两"), "CN_DIGITS 含「两」");

// 2) SECTION_RE 为带 g/m 标志的 RegExp（覆盖 extract-outline 契约）
ok(SECTION_RE instanceof RegExp, "SECTION_RE 为 RegExp");
ok(SECTION_RE.global && SECTION_RE.multiline, "SECTION_RE 带 g+m 标志");

// 3) isHeadingLine 各分支
ok(isHeadingLine("## 二级标题"), "markdown ## 命中");
ok(isHeadingLine("### 三级标题"), "markdown ### 命中");
ok(isHeadingLine("一、糖尿病"), "一、 命中");
ok(isHeadingLine("二．诊断"), "二． 命中");
ok(isHeadingLine("（一）筛查"), "（一） 命中");
ok(isHeadingLine("（二）治疗"), "（二） 命中");
ok(isHeadingLine("１．适应证"), "全角数字１． 命中（漂移修复点）");
ok(isHeadingLine("２、用法"), "全角数字２、 命中（漂移修复点）");
ok(isHeadingLine("1. 剂量"), "ASCII 1. 命中");
ok(isHeadingLine("2、注意"), "ASCII 2、 命中");
ok(isHeadingLine("  一、缩进标题"), "行首空白缩进仍命中");
ok(isHeadingLine("一）附录"), "宽松尾括号 一） 命中（normalize 变体）");
ok(isHeadingLine("（一 无尾括号"), "宽松无尾括号（一 命中（normalize 变体）");
ok(!isHeadingLine("这是一段普通正文，没有标题。"), "普通正文不命中");
ok(!isHeadingLine(""), "空串不命中");
ok(!isHeadingLine(null), "null 不命中");
ok(!isHeadingLine("##### 五级超纲"), "五级 # 不在 #{2,4} 范围不命中");

// 4) countHeadings
const sample = [
  "## 总则",
  "一、糖尿病",
  "（一）诊断",
  "１．适应证",
  "2、注意",
  "这是正文段落。",
  "两、妊娠处理", // 含「两」——ab 原会漏计
].join("\n");
ok(countHeadings(sample) === 6, `countHeadings 计 6 行（7 行中 1 行为正文，含「两、」与全角１．）实际=${countHeadings(sample)}`);
ok(countHeadings("") === 0, "countHeadings 空串=0");
ok(countHeadings(null) === 0, "countHeadings null=0");

// 5) SECTION_RE 11 捕获组契约（extract-outline.parseFile 依赖，绝不可改）
function grp(s) { SECTION_RE.lastIndex = 0; return SECTION_RE.exec(s); }
let m;
m = grp("## 标题"); ok(m && m[1] === "##" && m[2] === "标题", "组1,2 markdown ## + 标题");
m = grp("一、糖尿病"); ok(m && m[3] === "一、" && m[4] === "糖尿病", "组3,4 一、 + 标题");
m = grp("（一）筛查"); ok(m && m[5] === "一" && m[6] === "筛查", "组5,6 （一） + 标题");
m = grp("１．用法"); ok(m && m[7] === "１．" && m[8] === "用法", "组7,8 全角１． + 标题");
m = grp("1. 剂量"); ok(m && m[9] === "1" && m[10] === "." && m[11] === "剂量", "组9,10,11 1. + 标题");

console.log(`\n结果 ===\n通过 ${pass} / ${pass + fail}`);
process.exit(fail === 0 ? 0 : 1);
