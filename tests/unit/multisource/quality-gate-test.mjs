// tests/unit/multisource/quality-gate-test.mjs
// 四重质检闸门纯函数单测（原生 node 运行，无网络/引擎依赖）。
import {
  gateLicense, gateAuthority, gateRecency, gateRelevance, evaluateCandidate, AUTHORITY,
} from "../../../scripts/kb/multisource/quality-gate.mjs";

let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}  ${detail}`); }
}

console.log("[quality-gate] 许可闸门");
ok("cc-by 通过", gateLicense({ license: "cc-by" }).pass);
ok("cc0 通过", gateLicense({ license: "CC0" }).pass);
ok("OA 标志(无许可串)通过", gateLicense({ openAccess: true }).pass);
ok("付费墙拒绝", !gateLicense({ license: "all rights reserved" }).pass);
ok("未知许可拒绝", !gateLicense({ license: null }).pass && !gateLicense({ openAccess: false }).pass);
ok("CC-BY 链接通过", gateLicense({ licenseUrl: "https://creativecommons.org/licenses/by/4.0/" }).pass);

console.log("[quality-gate] 权威闸门");
ok("guideline=5", gateAuthority({ authority: "guideline" }).score === AUTHORITY.GUIDELINE);
ok("society=3", gateAuthority({ authority: "society" }).score === AUTHORITY.SOCIETY);
ok("paper=1", gateAuthority({ authority: "paper" }).score === AUTHORITY.PAPER);
ok("unknown=0", gateAuthority({ authority: "???".slice(0,0) }).score === AUTHORITY.UNKNOWN);

console.log("[quality-gate] 时效闸门");
ok("近年限通过", gateRecency({ year: 2024 }).pass && !gateRecency({ year: 2024 }).stale);
ok("超龄标红不拒", gateRecency({ year: 2005 }).pass && gateRecency({ year: 2005 }).stale);
ok("无年份不拒", gateRecency({ year: null }).pass);

console.log("[quality-gate] 相关闸门");
ok("命中中文关键词", gateRelevance({ title: "急性心梗管理", disease: "急性心梗", text: "再灌注治疗" }, { disease: "急性心梗" }).pass);
ok("未命中拒绝", !gateRelevance({ title: "Diabetes care", text: "insulin" }, { disease: "急性心梗", keywords: ["急性心梗"] }).pass);
ok("英文词元可命中", gateRelevance({ title: "myocardial infarction management" }, { disease: "x", keywords: ["myocardial", "infarction"] }).pass);

console.log("[quality-gate] 聚合裁决");
const good = evaluateCandidate(
  { title: "Acute Myocardial Infarction Guideline", license: "cc-by", openAccess: true, authority: "guideline", year: 2023, disease: "急性心梗", text: "ST-elevation myocardial infarction reperfusion" },
  { disease: "急性心梗", keywords: ["急性心梗", "myocardial", "infarction"], minAuthority: 1 },
);
ok("优质候选通过且高分", good.pass && good.score > 0, JSON.stringify(good));
const bad = evaluateCandidate(
  { title: "Something else", license: null, openAccess: false, authority: "paper", year: 2020, disease: "急性心梗", text: "unrelated" },
  { disease: "急性心梗", keywords: ["急性心梗"], minAuthority: 1 },
);
ok("付费墙/未知许可拒绝", !bad.pass);

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
