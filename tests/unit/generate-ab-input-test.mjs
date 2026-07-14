// tests/unit/generate-ab-input-test.mjs
// 真 B 生成器纯函数单测（零 Key，原生 node 可跑）。
// 仅覆盖与 LLM 调用解耦的纯函数：buildItems / findMissing / validateInput / assembleInput。

import {
  buildItems,
  findMissing,
  validateInput,
  assembleInput,
} from "../../scripts/kb/generate-ab-input.mjs";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.error(`  ✗ ${name}`);
  }
}

// ---- 测试数据 ----
const GOLD = [
  {
    id: "Q01",
    q: "问题一",
    gtSources: ["指南A"],
    referenceAnswer: "参考一",
  },
  {
    id: "Q02",
    q: "问题二",
    gtSources: ["指南B"],
    referenceAnswer: "参考二",
  },
  {
    id: "Q03",
    q: "问题三",
    gtSources: [],
    referenceAnswer: "",
  },
];
const ANS = {
  Q01: { answerA: "A1", answerB: "B1" },
  Q02: { answerA: "A2", answerB: "" }, // B 缺失
  Q03: { answerA: "", answerB: "B3" }, // A 缺失
};

// ---- buildItems ----
const built = buildItems(GOLD, ANS, { promptA: "a.md", promptB: "b.md" });
ok("buildItems 数量对齐", built.length === 3);
ok("buildItems 取 id", built[0].id === "Q01");
ok("buildItems 取 q", built[1].q === "问题二");
ok("buildItems 取 gtSources", JSON.stringify(built[0].gtSources) === JSON.stringify(["指南A"]));
ok("buildItems 取 referenceAnswer", built[1].referenceAnswer === "参考二");
ok("buildItems 取 answerA", built[0].answerA === "A1");
ok("buildItems 取 answerB", built[0].answerB === "B1");
ok("buildItems 缺失 B 兜底空串", built[1].answerB === "");
ok("buildItems 缺失 A 兜底空串", built[2].answerA === "");
ok("buildItems 空 answersById 不崩", buildItems(GOLD, {}, {}).every((it) => it.answerA === "" && it.answerB === ""));
ok("buildItems 无 gtSources 兜底 []", JSON.stringify(built[2].gtSources) === "[]");

// ---- findMissing ----
const miss = findMissing(built);
ok("findMissing 标记 Q02(B空)", miss.includes("Q02"));
ok("findMissing 标记 Q03(A空)", miss.includes("Q03"));
ok("findMissing 不标记 Q01", !miss.includes("Q01"));
ok("findMissing 全空集合返回空", findMissing([]).length === 0);

const allFilled = buildItems(GOLD, { Q01: { answerA: "a", answerB: "b" }, Q02: { answerA: "a", answerB: "b" }, Q03: { answerA: "a", answerB: "b" } }, {});
ok("findMissing 全填返回空", findMissing(allFilled).length === 0);

// ---- validateInput ----
const goodInput = assembleInput({ meta: { promptA: "a", promptB: "b" }, items: allFilled });
ok("validateInput 合法通过", validateInput(goodInput).ok === true);

const noItems = assembleInput({ items: [] });
ok("validateInput 空 items 拒", validateInput(noItems).ok === false);

const badItems = { items: [{ id: "Q", q: "问题", answerA: "a" }] }; // 缺 answerB
const vBad = validateInput(badItems);
ok("validateInput 缺 answerB 拒", vBad.ok === false && vBad.errors.some((e) => e.includes("answerB")));

const nonObj = validateInput(null);
ok("validateInput 非对象拒", nonObj.ok === false);

const nonArr = validateInput({ items: "x" });
ok("validateInput items 非数组拒", nonArr.ok === false);

const missingId = validateInput({ items: [{ q: "问题", answerA: "a", answerB: "b" }] });
ok("validateInput 缺 id 拒", missingId.ok === false && missingId.errors.some((e) => e.includes("id")));

const missingQ = validateInput({ items: [{ id: "Q", answerA: "a", answerB: "b" }] });
ok("validateInput 缺 q 拒", missingQ.ok === false && missingQ.errors.some((e) => e.includes("q")));

// ---- assembleInput ----
const asm = assembleInput({ meta: { promptA: "a.md", promptB: "b.md", note: "测试" }, items: allFilled });
ok("assembleInput 填 promptA", asm.meta.promptA === "a.md");
ok("assembleInput 填 promptB", asm.meta.promptB === "b.md");
ok("assembleInput 填 note", asm.meta.note === "测试");
ok("assembleInput 自动加 generatedAt", typeof asm.meta.generatedAt === "string" && asm.meta.generatedAt.includes("T"));
ok("assembleInput 透传 items", asm.items.length === 3);
ok("assembleInput 无 meta 补默认", assembleInput({ items: allFilled }).meta.note.includes("自动生成"));

// ---- 汇总 ----
console.log(`\n=== 真 B 生成器单测结果 ===`);
console.log(`通过 ${pass} / ${pass + fail} | 失败 ${fail}`);
if (fail > 0) {
  console.error("存在失败用例");
  process.exit(1);
} else {
  console.log("全部通过 ✓");
}
