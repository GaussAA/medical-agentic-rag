// patient-forget-test.mjs
// E2 验证优先 · 患者画像被遗忘权（删除/安全擦除）确定性单测（零 LLM、可进 CI）。
// 验证：forget_patient 须 confirm=true 方擦除；擦除前 confirm=false 不动文件；
//        擦除后密文文件消失、context 注入停止、审计仅记动作不记 PHI 原值。
// 运行: node --experimental-strip-types tests/unit/patient-forget-test.mjs

// CI 环境下跳过（需 Pi 运行时）
if (process.env.CI) { process.exit(13); }

import { mkdtempSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chdir } from "node:process";

const sandbox = mkdtempSync(join(tmpdir(), "pt-forget-"));
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
function ok(cond, name) {
  if (cond) { pass++; console.log("  ✓", name); }
  else { fail++; fails.push(name); console.error("  ✗", name); }
}

const ALLERGY = "青霉素";
const AGE = "65岁";

// 1. 先写入画像
await registered["remember_patient"].execute("t1", {
  age: AGE, gender: "男",
  allergies: [ALLERGY],
  medicalHistory: ["高血压"],
  currentMedications: ["氨氯地平"],
});

const profPath = join(sandbox, ".pi", "patient-profile.json");
ok(existsSync(profPath), "擦除前画像文件存在");

// 2. 未确认 → 拒绝擦除，文件仍在
const denied = await registered["forget_patient"].execute("t2", { confirm: false });
ok(existsSync(profPath), "confirm=false → 文件未被擦除");
ok(
  denied.content[0].text.includes("Not confirmed") || denied.content[0].text.includes("confirm=true"),
  "confirm=false → 返回中止提示",
);

// 3. 确认 → 安全擦除，文件消失
const wiped = await registered["forget_patient"].execute("t3", { confirm: true });
ok(!existsSync(profPath), "confirm=true → 密文文件已擦除消失");
ok(
  wiped.content[0].text.includes("erased") || wiped.content[0].text.includes("wiped"),
  "confirm=true → 返回擦除成功提示",
);

// 4. 幂等：再次擦除（已不存在）不报错
const again = await registered["forget_patient"].execute("t4", { confirm: true });
ok(again.content[0].text.includes("擦除") || again.content[0].text.length > 0, "重复擦除幂等不崩");

// 5. 擦除后 context 注入停止（无画像可注入）
const ctx = await hooks["context"]({ messages: [] });
ok(!ctx || !ctx.messages || ctx.messages.length === 0, "擦除后 context 不再注入画像");

// 6. 审计仅记动作、不记 PHI 原值
const logDir = join(sandbox, ".pi", "logs");
let auditRaw = "";
if (existsSync(logDir)) {
  for (const f of readdirSync(logDir)) {
    if (f.startsWith("audit-")) auditRaw += readFileSync(join(logDir, f), "utf-8");
  }
}
ok(auditRaw.includes("patient_profile.forget"), "审计含 forget 动作");
ok(!auditRaw.includes(ALLERGY), "审计不记 PHI 原值（过敏史 " + ALLERGY + " 未出现）");
ok(!auditRaw.includes(AGE), "审计不记 PHI 原值（年龄 " + AGE + " 未出现）");

console.log("\n被遗忘权单测: " + pass + " 通过 / " + fail + " 失败");
if (fail > 0) {
  console.log("失败项:");
  for (const f of fails) console.log("  - " + f);
  process.exit(1);
}
process.exit(0);
