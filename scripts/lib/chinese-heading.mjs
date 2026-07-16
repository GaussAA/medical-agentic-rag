// scripts/lib/chinese-heading.mjs
//
// 中文层级标题「单一真相源」。
//
// 此前中文标题正则散落四处、各自漂移：
//   - extract-outline.mjs  : SECTION_RE（捕获组，用于层级解析）
//   - chunk-quality.mjs     : SECTION_RE（布尔，orphan 检测）
//   - multisource/lib/normalize.mjs : hasCnHeading（布尔）
//   - ab-extract-diff.mjs  : HEADERS（计数）
// 漂移点：① ab 版 CN 集缺「两」；② chunk-quality / normalize 缺全角数字「１．」分支。
//
// 本模块统一导出，所有调用点复用同一套中文数字集与判定逻辑，杜绝再漂移。
// 纯函数、零模块副作用，可直接被 tests/unit 在原生 node 下单测。

// 中文数字集（含「两」，与 extract-outline 原 CN_NUM 对齐）
export const CN_DIGITS = "一二三四五六七八九十百零两";

// 章节捕获正则（与 extract-outline 原 SECTION_RE 完全等价，保 11 捕获组契约）
// 组布局（extract-outline.parseFile 依赖，不可改）：
//   1,2   markdown ## ### ####
//   3,4   一、 二． 三、
//   5,6   （一）（二）
//   7,8   １． ２． 全角数字
//   9,10,11 1. 2、 ASCII 数字
export const SECTION_RE = new RegExp(
  "^(?:[ \\t]*)(#{2,4})\\s+(.+)" + // 1,2 markdown ## ### ####
    "|^(?:[ \\t]*)([" + CN_DIGITS + "]+[.．、])\\s*(.+)" + // 3,4 一、 二． 三、
    "|^(?:[ \\t]*)（([" + CN_DIGITS + "]+)）\\s*(.+)" + // 5,6 （一）（二）
    "|^(?:[ \\t]*)([０-９]+[.．、])\\s*(.+)" + // 7,8 １． ２． 全角
    "|^(?:[ \\t]*)(\\d+)([.、])\\s*(.+)", // 9,10,11 1. 2、 ASCII
  "gm"
);

// 单行标题判定（布尔）。并集四家行为，含 markdown / 中文层级 / 全角数字 / ASCII 数字，
// 并兼容 normalize 的「一）」「（一」两种宽松变体。用于 orphan 检测、结构补分区、计数。
const HEADING_LINE_RE = new RegExp(
  "^[ \\t]*" +
    "(#{2,4}\\s+.+" + // markdown
    "|[" + CN_DIGITS + "]+[.．、）]" + // 一、 二． 三、 或 一） 宽松尾括号
    "|（[" + CN_DIGITS + "]+）?" + // （一）（二）或（一 宽松无尾括号
    "|[０-９]+[.．、]" + // １． ２． 全角数字（漂移修复点）
    "|[0-9]+[.、])" // 1. 2、 ASCII 数字
);

export function isHeadingLine(line) {
  if (line == null) return false;
  return HEADING_LINE_RE.test(String(line));
}

// 统计文本中的中文层级标题行数（供 ab-extract-diff 对照计数）。
export function countHeadings(text) {
  if (!text) return 0;
  return text.split(/\r?\n/).filter(isHeadingLine).length;
}
