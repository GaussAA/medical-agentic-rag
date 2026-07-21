// compliance-test.mjs
// 合规基础设施单测 —— 验证 lib/phi-crypto.mjs 的加密往返、旧明文迁移、
// 密钥自动生成、PII 脱敏与审计写入。原生 node 直接运行，无需 API Key / jiti。
//
// 运行：node tests/unit/compliance-test.mjs
//
// 注意：本测试使用独立临时目录作为 cwd，避免污染项目真实 .pi/ 与 logs/。

import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

// —— 在导入被测模块前切换 cwd 到临时目录（模块用 process.cwd() 定位 .pi/logs）——
const workdir = mkdtempSync(join(tmpdir(), "phi-test-"));
const origCwd = process.cwd();
process.chdir(workdir);
delete process.env.PATIENT_DATA_KEY; // 确保走"自动生成密钥"分支

const MOD = pathToFileURL(join(origCwd, ".pi/extensions/lib/phi-crypto.mjs")).href;
const phi = await import(MOD);

let passed = 0;
let failed = 0;
const results = [];

function check(name, cond, detail = "") {
  if (cond) {
    passed++;
    results.push({ name, ok: true, detail });
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    results.push({ name, ok: false, detail });
    console.log(`  ✗ ${name}  ${detail}`);
  }
}

console.log("\n=== 合规基础设施单测 ===\n");
console.log(`临时工作目录: ${workdir}\n`);

// —— 1. 密钥自动生成 ——
console.log("[1] 密钥管理");
const key1 = phi.getKey();
check("首次调用生成 32 字节密钥", Buffer.isBuffer(key1) && key1.length === 32);
check("密钥文件已落盘 .pi/.data-key", existsSync(join(workdir, ".pi", ".data-key")));
const key2 = phi.getKey();
check("二次调用返回同一密钥（缓存/持久一致）", key1.equals(key2));

// —— 2. 加密往返 ——
console.log("\n[2] AES-256-GCM 加密往返");
const secret = "患者过敏史：青霉素、头孢；既往：高血压 II 级";
const enc = phi.encrypt(secret);
check("密文带版本前缀 v1:gcm:", enc.startsWith("v1:gcm:"));
check("密文不含明文片段", !enc.includes("青霉素") && !enc.includes("高血压"));
check("解密还原一致", phi.decrypt(enc) === secret);
check("isEncrypted 正确识别密文", phi.isEncrypted(enc) === true);
check("isEncrypted 正确识别明文", phi.isEncrypted("{\"a\":1}") === false);

// —— 3. 篡改检测（GCM 认证）——
console.log("\n[3] 篡改检测");
let tamperCaught = false;
try {
  const body = enc.slice("v1:gcm:".length);
  const buf = Buffer.from(body, "base64");
  buf[buf.length - 1] ^= 0xff; // 翻转最后一字节
  phi.decrypt("v1:gcm:" + buf.toString("base64"));
} catch {
  tamperCaught = true;
}
check("密文被篡改时解密抛错（认证有效）", tamperCaught);

// —— 4. JSON 加解密 ——
console.log("\n[4] JSON 加解密");
const profile = { age: "65岁", allergies: ["青霉素"], medicalHistory: ["高血压"] };
const encJson = phi.encryptJSON(profile);
const { data, migrated } = phi.decryptJSON(encJson);
check("密文 JSON 往返对象一致", JSON.stringify(data) === JSON.stringify(profile));
check("密文解析 migrated=false", migrated === false);

// —— 5. 旧明文自动迁移 ——
console.log("\n[5] 旧明文兼容迁移");
const legacy = JSON.stringify(profile, null, 2); // 历史明文格式
const { data: ld, migrated: lm } = phi.decryptJSON(legacy);
check("旧明文可被解析", JSON.stringify(ld) === JSON.stringify(profile));
check("旧明文标记 migrated=true（提示回写）", lm === true);

// —— 6. PII 脱敏 ——
console.log("\n[6] PII 脱敏");
check("手机号脱敏", phi.maskPhone("联系电话 13812345678") === "联系电话 138****5678");
check(
  "身份证脱敏",
  phi.maskIdCard("身份证 110101199003072316") === "身份证 110101********2316",
);
check("邮箱脱敏", phi.maskEmail("张三 zhangsan@hospital.com") === "张三 z***@hospital.com");
check("姓名脱敏(2字)", phi.maskName("张三") === "张*");
check("姓名脱敏(4字)", phi.maskName("欧阳娜娜") === "欧***");
check("姓名脱敏(单字不动)", phi.maskName("张") === "张");
const combo = phi.maskPII("患者 13800001111，证件 110101199003072316，邮箱 a.b@x.cn");
check(
  "综合脱敏(手机+身份证+邮箱)",
  combo === "患者 138****1111，证件 110101********2316，邮箱 a***@x.cn",
  combo,
);
check("非 PII 数字不误伤(年龄65岁)", phi.maskPII("患者65岁，血压120") === "患者65岁，血压120");

// —— 7. 审计写入 ——
console.log("\n[7] 审计日志");
phi.auditLog("patient_profile.write", { fields: ["age", "allergies"] });
const auditFile = phi.auditFileToday();
check("审计文件生成", existsSync(auditFile));
const auditText = existsSync(auditFile) ? readFileSync(auditFile, "utf-8") : "";
check("审计记录含 action", auditText.includes("patient_profile.write"));
check("审计记录含字段名不含原值", auditText.includes("allergies") && !auditText.includes("青霉素"));

// —— 汇总 ——
console.log("\n=== 结果 ===");
console.log(`通过 ${passed} / ${passed + failed}`);

// 清理临时目录
process.chdir(origCwd);
try {
  rmSync(workdir, { recursive: true, force: true });
} catch {
  /* 尽力清理 */
}

// 输出机器可读结果
const report = {
  suite: "compliance",
  ts: new Date().toISOString(),
  passed,
  failed,
  total: passed + failed,
  results,
};
mkdirSync(join(origCwd, "tests"), { recursive: true });
writeFileSync(
  join(origCwd, "tests", "reports", "compliance-report.json"),
  JSON.stringify(report, null, 2),
  "utf-8",
);
console.log(`\n报告已写入 tests/reports/compliance-report.json`);

process.exit(failed === 0 ? 0 : 1);
