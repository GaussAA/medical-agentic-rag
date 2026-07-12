// query-sanitize-test.mjs
// 检索查询脱敏纯逻辑单测：零依赖、确定性，进 CI。
// 运行: node tests/unit/query-sanitize-test.mjs

import { sanitizeSearchQuery, sanitizeForLog } from "../../.pi/extensions/lib/query-sanitize.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(cond, name) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
    console.error("  ✗ " + name);
  }
}

// 1. PII 脱敏（与 phi-crypto maskPII 行为一致）
ok(
  sanitizeSearchQuery("患者电话 13812345678 的用药") ===
    "患者电话 138****5678 的用药",
  "手机号脱敏",
);
ok(
  sanitizeSearchQuery("身份证 110101199003072316 病史") ===
    "身份证 110101********2316 病史",
  "身份证脱敏",
);
ok(
  sanitizeSearchQuery("邮箱 a.b@x.cn 咨询") === "邮箱 a***@x.cn 咨询",
  "邮箱脱敏",
);

// 2. 正常医疗 query 不变（不误伤）
ok(
  sanitizeSearchQuery("高血压一线用药推荐") === "高血压一线用药推荐",
  "医疗 query 原样",
);
ok(
  sanitizeSearchQuery("患者65岁，血压120") === "患者65岁，血压120",
  "年龄/血压不误伤",
);

// 3. 前后空白 + 兜底
ok(sanitizeSearchQuery("  糖尿病饮食  ") === "糖尿病饮食", "去空白");
ok(sanitizeSearchQuery("") === "", "空串 → 空");
ok(sanitizeSearchQuery(null) === "", "null → 空");
ok(sanitizeSearchQuery(undefined) === "", "undefined → 空");

// 4. sanitizeForLog
ok(
  sanitizeForLog("联系 13800001111") === "联系 138****1111",
  "sanitizeForLog 脱敏",
);

console.log(`\n查询脱敏单测: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
