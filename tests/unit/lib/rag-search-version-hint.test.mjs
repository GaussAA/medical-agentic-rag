// rag-search-version-hint-test.mjs
// A 层增强·检索期版本冲突前置标注：验证 buildVersionConflictHint（纯函数，注入 guideMap）。
import { buildVersionConflictHint } from "../../../.pi/extensions/lib/conflict-detector.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, msg) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(msg);
    console.error("  ✗ " + msg);
  }
}

const GM = {
  "1.原发性肝癌诊疗指南（2026版）": { deprecated: false, supersededBy: null },
  "2.原发性肝癌诊疗指南（2019版）": { deprecated: true, supersededBy: "1.原发性肝癌诊疗指南（2026版）" },
  "3.肺炎诊疗指南（2023版）": { deprecated: false, supersededBy: "4.肺炎诊疗指南（2025版）" },
  "4.肺炎诊疗指南（2025版）": { deprecated: false, supersededBy: null },
};

// 1. 空结果 → ""
ok(buildVersionConflictHint([], GM) === "", "空结果 → 空提示");

// 2. guideMap null → ""
ok(buildVersionConflictHint([{ file_path: "x.txt" }], null) === "", "guideMap null → 空提示");

// 3. 单指南无冲突 → ""
ok(
  buildVersionConflictHint([{ file_path: "data/raw-txt/1.原发性肝癌诊疗指南（2026版）.txt" }], GM) === "",
  "正常现行指南 → 空提示",
);

// 4. 命中已废止指南 → 含「已废止」
{
  const h = buildVersionConflictHint([{ file_path: "data/raw-txt/2.原发性肝癌诊疗指南（2019版）.txt" }], GM);
  ok(h.includes("已废止"), "已废止指南 → 含「已废止」");
  ok(h.includes("建议优先《1.原发性肝癌诊疗指南（2026版）》"), "已废止 → 含 supersededBy 建议");
}

// 5. 命中有 supersededBy（未 deprecated）→ 含「有更新版」
{
  const h = buildVersionConflictHint([{ file_path: "data/raw-txt/3.肺炎诊疗指南（2023版）.txt" }], GM);
  ok(h.includes("有更新版"), "有更新版（未 deprecated）→ 含「有更新版」");
  ok(h.includes("建议优先《4.肺炎诊疗指南（2025版）》"), "含更新版建议");
}

// 6. 多指南（一正常一废止）→ 仅标废止的
{
  const h = buildVersionConflictHint(
    [
      { file_path: "data/raw-txt/1.原发性肝癌诊疗指南（2026版）.txt" },
      { file_path: "data/raw-txt/2.原发性肝癌诊疗指南（2019版）.txt" },
    ],
    GM,
  );
  ok(h.includes("2.原发性肝癌诊疗指南（2019版）") && h.includes("已废止"), "多指南 → 标废止项");
  ok(!h.includes("1.原发性肝癌诊疗指南（2026版）》已废止"), "多指南 → 不误标正常项");
}

// 7. 异常 guideMap（非对象）→ 降级 ""
ok(buildVersionConflictHint([{ file_path: "x.txt" }], "not-an-object") === "", "异常 guideMap → 降级空");

console.log(`\n检索期版本冲突标注单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
