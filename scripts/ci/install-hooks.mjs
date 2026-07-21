// install-hooks.mjs
// 将 scripts/hooks/ 下的 git 钩子安装到 .git/hooks/（幂等、可重复执行）。
// 运行: npm run hooks:install
//
// 设计：仅复制、不破坏既有钩子（若目标已存在且内容不同，先备份为 .bak）。
// 钩子为 bash 脚本，Windows Git Bash 下由 git 的 sh 执行；故同时 chmod +x。

import { existsSync, readFileSync, writeFileSync, copyFileSync, renameSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SRC_DIR = join(__dirname, "hooks");
const GIT_DIR = join(__dirname, "..", "..", ".git");
const HOOKS_DIR = join(GIT_DIR, "hooks");

const HOOKS = ["pre-push"];

function installOne(name) {
  const src = join(SRC_DIR, name);
  if (!existsSync(src)) {
    console.error(`  ✗ 源钩子缺失: ${src}`);
    return false;
  }
  if (!existsSync(GIT_DIR)) {
    console.error(`  ✗ 非 git 仓库（.git 不存在），跳过 ${name}`);
    return false;
  }
  const dst = join(HOOKS_DIR, name);
  if (existsSync(dst)) {
    const cur = readFileSync(dst, "utf-8");
    const want = readFileSync(src, "utf-8");
    if (cur === want) {
      console.log(`  • ${name} 已是最新，跳过`);
      return true;
    }
    // 内容不同 → 备份既有钩子，避免覆盖用户自定义
    const bak = dst + ".bak";
    try {
      renameSync(dst, bak);
      console.log(`  ⚠ ${name} 已存在且不同，备份为 ${name}.bak`);
    } catch (e) {
      console.error(`  ✗ 备份 ${name} 失败: ${e?.message || e}`);
      return false;
    }
  }
  try {
    copyFileSync(src, dst);
    try {
      chmodSync(dst, 0o755);
    } catch {
      /* Windows Git Bash 下 chmod 非必需，忽略 */
    }
    console.log(`  ✓ 已安装 ${name} → .git/hooks/${name}`);
    return true;
  } catch (e) {
    console.error(`  ✗ 安装 ${name} 失败: ${e?.message || e}`);
    return false;
  }
}

console.log("安装 git 钩子:");
let allOk = true;
for (const h of HOOKS) allOk = installOne(h) && allOk;
console.log(allOk ? "钩子安装完成。" : "部分钩子安装失败，请检查。");
process.exit(allOk ? 0 : 1);
