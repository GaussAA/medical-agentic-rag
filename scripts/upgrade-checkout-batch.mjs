// scripts/upgrade-checkout-batch.mjs
// 分批 checkout v0.84.1 变更文件（绕开 VS Code 语言服务的瞬态文件锁）
// 用法: node scripts/upgrade-checkout-batch.mjs <list-file> <batch-size>
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const ROOT = join(process.cwd(), "pi");
const LIST = process.argv[2];
const BATCH = parseInt(process.argv[3] || "60", 10);
const files = readFileSync(LIST, "utf8").split("\n").map(s => s.trim()).filter(Boolean);

let ok = 0, fail = 0;
const failed = [];
for (let i = 0; i < files.length; i += BATCH) {
  const chunk = files.slice(i, i + BATCH);
  let done = false;
  for (let attempt = 1; attempt <= 3 && !done; attempt++) {
    const r = spawnSync("git", ["checkout", "--force", "v0.84.1", "--", ...chunk], {
      cwd: ROOT, encoding: "utf8", shell: false,
    });
    if (r.status === 0) { done = true; ok += chunk.length; }
    else if (attempt === 3) {
      // 逐文件降级重试（定位真正锁死的文件）
      let chunkOk = 0;
      for (const f of chunk) {
        const r2 = spawnSync("git", ["checkout", "--force", "v0.84.1", "--", f], { cwd: ROOT, encoding: "utf8" });
        if (r2.status === 0) chunkOk++;
        else failed.push(f);
      }
      ok += chunkOk; fail += chunk.length - chunkOk;
    }
    if (!done) spawnSync("cmd", ["/c", "timeout", "/t", "2"], { stdio: "ignore" });
  }
  if ((i / BATCH) % 5 === 0) console.log(`[batch] ${Math.min(i + BATCH, files.length)}/${files.length} ok=${ok} fail=${fail}`);
}
console.log(`\n=== 完成: ok=${ok} fail=${fail} ===`);
if (failed.length) { console.log("失败文件:"); for (const f of failed) console.log("  " + f); }
process.exit(fail > 0 ? 1 : 0);
