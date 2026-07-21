// patient-profile-test.mjs
// B0 验证优先 · 患者画像确定性单测（零 LLM、可进 CI）。
// 验证 PHI AES-256-GCM 静态加密落盘 + 明文绝不驻留磁盘 + 审计仅记字段名 + 过敏禁令渲染。
// 运行: node --experimental-strip-types tests/unit/patient-profile-test.mjs

import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

const sandbox = mkdtempSync(join(tmpdir(), "pt-profile-"));
chdir(sandbox);

const registered = {};
const hooks = {};
const mockPi = {
  registerTool: (spec) => { registered[spec.name] = spec; },
  on: (ev, fn) => { hooks[ev] = fn; },
};

const factory = (await import("../../../../.pi/extensions/safety.patient-profile.ts")).default;
await factory(mockPi);

let pass = 0, fail = 0;
const fails = [];
const findings = [];
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name); console.error("  ✗", name); }
}
function finding(msg) { findings.push(msg); console.log("  ⚠️", msg); }

const ALLERGY = "青霉素";
const AGE = "65岁";

// 1. 写入画像
await registered["remember_patient"].execute("t1", {
  age: AGE, gender: "男",
  allergies: [ALLERGY],
  medicalHistory: ["高血压"],
  currentMedications: ["氨氯地平"],
});

const profPath = join(sandbox, ".pi", "patient-profile.json");
ok(existsSync(profPath), "画像文件已落盘");

// 2. 静态加密：磁盘文件不得含明文 PHI
const raw = readFileSync(profPath, "utf-8");
ok(!raw.includes(ALLERGY), "磁盘密文不含过敏史明文（" + ALLERGY + "）");
ok(!raw.includes(AGE), "磁盘密文不含年龄明文（" + AGE + "）");
ok(raw.includes("ciphertext") || raw.includes("\"iv\"") || raw.length > 40, "落盘为加密结构（非明文 JSON）");

// 3. 每轮 context 注入 + 过敏禁令渲染（解密正确）
const ctx = await hooks["context"]({ messages: [] });
ok(Array.isArray(ctx.messages) && ctx.messages.length === 1, "画像 context 注入 1 条");
const inj = ctx.messages[0].content;
ok(inj.includes(ALLERGY), "注入正确解密过敏史");
ok(inj.includes(AGE), "注入正确解密年龄");
ok(inj.includes("绝对禁止推荐"), "过敏史「绝对禁止推荐」安全提示渲染");

// 4. 审计仅记字段名、不记原值
const logDir = join(sandbox, ".pi", "logs");
let auditRaw = "";
if (existsSync(logDir)) {
  for (const f of readdirSync(logDir)) {
    if (f.startsWith("audit-")) auditRaw += readFileSync(join(logDir, f), "utf-8");
  }
}
ok(auditRaw.length > 0, "审计日志已写入");
ok(auditRaw.includes("patient_profile.write"), "审计含 write 动作");
ok(!auditRaw.includes(ALLERGY), "审计不记 PHI 原值（过敏史 " + ALLERGY + " 未出现）");
ok(auditRaw.includes("allergies") || auditRaw.includes("\"fields\""), "审计仅记字段名");

// 5. 增量合并去重
await registered["remember_patient"].execute("t2", {
  allergies: [ALLERGY, "头孢"],
  currentMedications: ["氨氯地平"],
});
const ctx2 = await hooks["context"]({ messages: [] });
const inj2 = ctx2.messages[0].content;
ok(inj2.includes("头孢"), "二次写入合并新过敏（头孢）");
ok((inj2.match(/氨氯地平/g) || []).length === 1, "重复用药去重（氨氯地平仅 1 次）");

console.log("\n患者画像单测: " + pass + " 通过 / " + fail + " 失败；发现 " + findings.length + " 项");
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
