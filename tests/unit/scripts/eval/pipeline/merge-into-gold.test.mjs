// merge-into-gold-test.mjs
// C3 受控自动并入守卫契约测试（纯 node，零 LLM）。
// 验证 mergeIntoGold 默认 OFF 且层层守卫，绝不污染受控 gold。

import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mergeIntoGold } from "../../../../../.pi/extensions/lib/feedback-loop.mjs";

let pass = 0;
let fail = 0;
function ok(cond, msg) {
  if (cond) {
    pass++;
    console.log("  ✓ " + msg);
  } else {
    fail++;
    console.error("  ✗ " + msg);
  }
}

// 隔离 IO：tmp 目录下的 gold / candidates，绝不碰受控 tests/gold-answers.json
const d = mkdtempSync(join(tmpdir(), "mgold-"));
const goldPath = join(d, "gold-answers.json");
const candPath = join(d, "gold-candidates.json");
const cand = {
  id: "CAND-eval_low_test",
  fromType: "eval_low_faithfulness",
  department: "测试科",
  guides: ["测试指南"],
  severity: "medium",
  count: 3,
  rationale: "补 gold 样例",
  status: "candidate",
  reviewedBy: "reviewer@med", // 人工审阅签名
};
writeFileSync(candPath, JSON.stringify([cand], null, 2), "utf-8");

console.log("═══ C3 mergeIntoGold 守卫契约 ═══");

// 1. 默认 OFF：无 env、无 enabled → 拒绝且不写任何文件
delete process.env.GOLD_AUTO_MERGE;
const r1 = mergeIntoGold({ ...cand }, { goldPath, candidatesPath: candPath });
ok(r1.merged === false && r1.reason === "guard-off", "默认 off → 拒绝并入(guard-off)");
ok(!existsSync(goldPath), "默认 off → 绝不创建/写入 gold 文件（零污染）");

// 2. 启用但缺人工审阅签名 → 拒绝
process.env.GOLD_AUTO_MERGE = "1";
const r2 = mergeIntoGold({ id: "CAND-eval_low_test" }, { goldPath, candidatesPath: candPath });
ok(r2.merged === false && r2.reason === "needs-review", "缺 reviewedBy → 拒绝(needs-review)");

// 3. 启用 + 审阅 + 在候选中 → 并入成功且落盘
const r3 = mergeIntoGold({ ...cand }, { goldPath, candidatesPath: candPath });
ok(r3.merged === true && r3.id === "CAND-eval_low_test", "完备条件 → 并入成功");
ok(existsSync(goldPath), "并入后 → gold 文件落盘");
const gold = JSON.parse(readFileSync(goldPath, "utf-8"));
ok(Array.isArray(gold) && gold.length === 1 && gold[0].id === "CAND-eval_low_test", "gold 内容含该候选");

// 4. 不在候选清单 → 拒绝（防凭空注入）
const outsider = { id: "OUTSIDE-x", reviewedBy: "someone" };
const r4 = mergeIntoGold(outsider, { goldPath, candidatesPath: candPath });
ok(r4.merged === false && r4.reason === "not-in-candidates", "非候选清单 → 拒绝(not-in-candidates)");

// 5. 重复并入 → 拒绝（幂等）
const r5 = mergeIntoGold({ ...cand }, { goldPath, candidatesPath: candPath });
ok(r5.merged === false && r5.reason === "already-exists", "重复并入 → 拒绝(already-exists)");

console.log(`\nmerge-into-gold-test: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
