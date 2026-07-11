/**
 * 患者画像扩展集成验证
 *
 * 验证 remember_patient 工具 + context 注入钩子的完整逻辑：
 *   - 工具/事件注册
 *   - 空画像不注入
 *   - execute 写入磁盘
 *   - context 注入画像到消息首位
 *   - 数组增量合并去重、字符串覆盖更新
 *
 * 前置: esbuild 编译扩展 -> scripts/ops/.patient-profile-compiled.mjs
 *   node pi/node_modules/esbuild/bin/esbuild .pi/extensions/patient-profile.ts \
 *     --format=esm --platform=node --outfile=scripts/ops/.patient-profile-compiled.mjs
 *
 * 用法: node scripts/ops/verify-patient-profile.mjs
 */
import { readFile, unlink } from "node:fs/promises";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const projectRoot = process.cwd();
const compiledPath = join(projectRoot, "scripts", ".patient-profile-compiled.mjs");
execSync(
  `node "${join(projectRoot, "pi", "node_modules", "esbuild", "bin", "esbuild")}" ` +
    `"${join(projectRoot, ".pi", "extensions", "patient-profile.ts")}" ` +
    `--format=esm --platform=node --outfile="${compiledPath}"`,
  { stdio: "pipe" }
);

const factory = (await import(pathToFileURL(compiledPath).href)).default;
const PROFILE_PATH = join(process.cwd(), ".pi", "patient-profile.json");

const registered = { tools: [], handlers: {} };
const mockPi = {
  registerTool: (t) => registered.tools.push(t),
  on: (event, handler) => {
    registered.handlers[event] = handler;
  },
};

try {
  await unlink(PROFILE_PATH);
} catch {}

await factory(mockPi);

let pass = 0;
let fail = 0;
function check(name, cond) {
  if (cond) {
    console.log(`  OK   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}`);
    fail++;
  }
}

console.log("=== 患者画像扩展验证 ===\n");

check("注册了 remember_patient 工具", registered.tools.some((t) => t.name === "remember_patient"));
check("注册了 context 事件钩子", "context" in registered.handlers);

const tool = registered.tools.find((t) => t.name === "remember_patient");
const ctxHandler = registered.handlers["context"];

console.log("\n-- 空画像时 context 不注入 --");
const emptyRes = await ctxHandler({ type: "context", messages: [{ role: "user", content: "你好", timestamp: 0 }] });
check("空画像返回 void（不注入）", emptyRes === undefined);

console.log("\n-- execute 写入画像 --");
const r1 = await tool.execute({ age: "65岁", gender: "男", allergies: ["青霉素"] });
check("execute 返回成功信息", r1.content[0].text.includes("已更新"));
const saved = JSON.parse(await readFile(PROFILE_PATH, "utf-8"));
check("磁盘 age=65岁", saved.age === "65岁");
check("磁盘 allergies 含青霉素", saved.allergies.includes("青霉素"));

console.log("\n-- context 注入画像 --");
const ctxRes = await ctxHandler({
  type: "context",
  messages: [{ role: "user", content: "肝癌治疗", timestamp: 0 }],
});
check("返回 messages 数组", Array.isArray(ctxRes?.messages));
check("注入消息在首位且含患者画像", ctxRes.messages[0].content.includes("患者画像"));
check("注入消息含过敏史青霉素", ctxRes.messages[0].content.includes("青霉素"));
check("注入消息含安全提示（禁止推荐）", ctxRes.messages[0].content.includes("禁止推荐"));
check("保留原消息（长度2）", ctxRes.messages.length === 2 && ctxRes.messages[1].content === "肝癌治疗");

console.log("\n-- 增量合并去重 --");
await tool.execute({ allergies: ["青霉素", "头孢"], medicalHistory: ["高血压"] });
const saved2 = JSON.parse(await readFile(PROFILE_PATH, "utf-8"));
check("青霉素不重复", saved2.allergies.filter((x) => x === "青霉素").length === 1);
check("新增头孢", saved2.allergies.includes("头孢"));
check("新增病史高血压", saved2.medicalHistory.includes("高血压"));

console.log("\n-- 字符串覆盖更新 --");
await tool.execute({ age: "66岁" });
const saved3 = JSON.parse(await readFile(PROFILE_PATH, "utf-8"));
check("age 覆盖 65->66", saved3.age === "66岁");

try {
  await unlink(PROFILE_PATH);
} catch {}

console.log(`\n=== 结果: ${pass} passed, ${fail} failed ===`);
process.exit(fail > 0 ? 1 : 0);
