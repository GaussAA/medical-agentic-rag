// conflict-detector-test.mjs
// 跨指南冲突检测单元测：所有外部依赖（检索/guideMap/LLM判定/可用性）注入 mock，
// 零真 LLM、CI 确定性。覆盖：单指南/双指南+版本冲突/双指南+内容冲突/无冲突/
// 旁路/空回答/检索失败/批注格式/工具函数。

import {
  detectConflicts,
  collectGuideNames,
  matchGuideMeta,
  buildAnnotation,
} from "../../.pi/extensions/lib/conflict-detector.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) {
    pass++;
  } else {
    fail++;
    fails.push(name);
    console.error("  ✗ " + name);
  }
}

// ---- mock 构件 ----
const TWO_GUIDES_RES = {
  results: [
    { file_path: "动脉粥样硬化诊治指南.md", snippet: "推荐高强度他汀起始治疗。" },
    { file_path: "血脂异常防治指南.md", snippet: "推荐中等强度他汀，特定人群高强度。" },
  ],
};
const ONE_GUIDE_RES = { results: [{ file_path: "单指南.md", snippet: "x" }] };

const GUIDE_MAP = {
  动脉粥样硬化诊治指南: { deprecated: true, supersededBy: "动脉粥样硬化诊治指南（2023更新版）" },
  血脂异常防治指南: { deprecated: false, supersededBy: null },
  单指南: { deprecated: false, supersededBy: null },
};

const mockSearch = (res) => async () => res;
const mockLoad = (map) => () => map;
const judgeConflictTrue = async () => ({ conflict: true, summary: "他汀强度推荐不同" });
const judgeConflictFalse = async () => ({ conflict: false, summary: "" });
const availTrue = () => true;

async function run() {
  // 1) 单指南命中 → pass
  {
    const r = await detectConflicts({
      question: "q",
      answer: "a".repeat(80),
      search: mockSearch(ONE_GUIDE_RES),
      loadGuideIndex: mockLoad(GUIDE_MAP),
      judge: judgeConflictFalse,
      isAvailable: availTrue,
    });
    ok(r.action === "pass" && r.reason === "single_guide_hit", "单指南命中→pass");
  }

  // 2) 双指南 + 版本冲突（deprecated）→ annotate 含版本差异
  {
    const r = await detectConflicts({
      question: "他汀怎么用",
      answer: "a".repeat(80),
      search: mockSearch(TWO_GUIDES_RES),
      loadGuideIndex: mockLoad(GUIDE_MAP),
      judge: judgeConflictFalse,
      isAvailable: availTrue,
    });
    ok(r.action === "annotate", "双指南+版本冲突→annotate");
    ok(
      r.conflicts.some((c) => c.type === "version" && c.guide.includes("动脉粥样硬化")),
      "版本冲突含废止指南",
    );
    ok(r.annotation.includes("版本差异") && r.annotation.includes("已标记为废止"), "批注含版本差异措辞");
  }

  // 3) 双指南 + 内容冲突（judge=true）→ annotate 含意见分歧
  {
    const r = await detectConflicts({
      question: "他汀强度",
      answer: "a".repeat(80),
      search: mockSearch(TWO_GUIDES_RES),
      loadGuideIndex: mockLoad({ 动脉粥样硬化诊治指南: { deprecated: false }, 血脂异常防治指南: { deprecated: false } }),
      judge: judgeConflictTrue,
      isAvailable: availTrue,
    });
    ok(r.action === "annotate", "双指南+内容冲突→annotate");
    ok(r.conflicts.some((c) => c.type === "content"), "内容冲突类型存在");
    ok(r.annotation.includes("意见分歧") && r.annotation.includes("他汀强度推荐不同"), "批注含意见分歧摘要");
  }

  // 4) 双指南 + 无冲突（无 deprecated + judge=false）→ pass
  {
    const r = await detectConflicts({
      question: "q",
      answer: "a".repeat(80),
      search: mockSearch(TWO_GUIDES_RES),
      loadGuideIndex: mockLoad({ 动脉粥样硬化诊治指南: { deprecated: false }, 血脂异常防治指南: { deprecated: false } }),
      judge: judgeConflictFalse,
      isAvailable: availTrue,
    });
    ok(r.action === "pass" && r.reason === "no_conflict", "双指南无冲突→pass");
  }

  // 5) 旁路 CONFLICT_DETECT=off
  {
    const prev = process.env.CONFLICT_DETECT;
    process.env.CONFLICT_DETECT = "off";
    const r = await detectConflicts({
      question: "q",
      answer: "a".repeat(80),
      search: mockSearch(TWO_GUIDES_RES),
      loadGuideIndex: mockLoad(GUIDE_MAP),
      judge: judgeConflictTrue,
      isAvailable: availTrue,
    });
    process.env.CONFLICT_DETECT = prev;
    ok(r.action === "pass" && r.reason === "disabled", "CONFLICT_DETECT=off→pass");
  }

  // 6) 空回答 → pass
  {
    const r = await detectConflicts({
      question: "q",
      answer: "   ",
      search: mockSearch(TWO_GUIDES_RES),
      loadGuideIndex: mockLoad(GUIDE_MAP),
      judge: judgeConflictTrue,
      isAvailable: availTrue,
    });
    ok(r.action === "pass" && r.reason === "empty_answer", "空回答→pass");
  }

  // 7) 检索失败 → 降级 pass（不阻断）
  {
    const r = await detectConflicts({
      question: "q",
      answer: "a".repeat(80),
      search: async () => {
        throw new Error("db down");
      },
      loadGuideIndex: mockLoad(GUIDE_MAP),
      judge: judgeConflictTrue,
      isAvailable: availTrue,
    });
    ok(r.action === "pass" && r.reason.startsWith("search_failed"), "检索失败→降级pass");
  }

  // 8) LLM 不可用 → 内容冲突层跳过，但版本冲突仍生效（Layer1 独立于 LLM）
  {
    const r = await detectConflicts({
      question: "q",
      answer: "a".repeat(80),
      search: mockSearch(TWO_GUIDES_RES),
      loadGuideIndex: mockLoad(GUIDE_MAP),
      judge: judgeConflictTrue,
      isAvailable: () => false,
    });
    ok(r.action === "annotate", "LLM不可用时版本冲突仍批注");
    ok(!r.conflicts.some((c) => c.type === "content"), "LLM不可用时无内容冲突");
  }

  // 9) 工具函数：collectGuideNames 去重去 .md
  {
    const names = collectGuideNames([
      { file_path: "A.md" },
      { file_path: "A.md" },
      { file_path: "B/../B.md" },
    ]);
    ok(names.length === 2 && names.includes("A") && names.includes("B"), "collectGuideNames 去重去.md");
  }

  // 10) 工具函数：matchGuideMeta 双向包含 + 去序号
  {
    const m1 = matchGuideMeta("1.健康体检自测问卷（2025年版）", {
      "健康体检自测问卷（2025年版）": { deprecated: true, supersededBy: "X" },
    });
    ok(m1 && m1.deprecated === true, "matchGuideMeta 去序号匹配");
    const m2 = matchGuideMeta("短名", { "很长的短名片段指南": { deprecated: false } });
    ok(m2 !== null, "matchGuideMeta 双向包含匹配");
  }

  // 11) buildAnnotation 混合格式
  {
    const ann = buildAnnotation([
      { type: "version", guide: "G1", deprecated: true, supersededBy: "G2" },
      { type: "content", guides: ["G3", "G4"], summary: "剂量不同" },
    ]);
    ok(ann.startsWith("⚠️ 跨指南提示"), "批注开头");
    ok(ann.includes("版本差异") && ann.includes("《G1》") && ann.includes("《G2》"), "批注含版本差异与现行版");
    ok(ann.includes("意见分歧") && ann.includes("《G3》") && ann.includes("《G4》") && ann.includes("剂量不同"), "批注含意见分歧");
  }

  console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
  if (fail > 0) {
    console.log("失败项:");
    for (const f of fails) console.log("  -", f);
    process.exit(1);
  }
  process.exit(0);
}

run().catch((e) => {
  console.error("测试运行异常:", e);
  process.exit(1);
});
