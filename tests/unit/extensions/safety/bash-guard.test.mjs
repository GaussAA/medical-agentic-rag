/**
 * bash 护栏纯函数单测（双可测：原生 node 直跑）
 * 运行：node tests/bash-guard-test.mjs
 */
import {
  normalizeBashParams,
  resolveTimeoutSec,
  assessCommand,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
} from "../../../../.pi/extensions/lib/bash-guard.mjs";

let pass = 0;
let fail = 0;
function ok(name, cond) {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}`); }
}

console.log("=== normalizeBashParams：入参形态兼容 ===");
ok("普通对象", normalizeBashParams({ command: "ls", timeout: 5 }).command === "ls");
ok("对象带 timeout", normalizeBashParams({ command: "ls", timeout: 5 }).timeout === 5);
ok("JSON 字符串", normalizeBashParams(JSON.stringify({ command: "pwd" })).command === "pwd");
ok("纯字符串降级为命令", normalizeBashParams("echo hi").command === "echo hi");
ok("嵌套 arguments(字符串)", normalizeBashParams({ arguments: JSON.stringify({ command: "whoami" }) }).command === "whoami");
ok("嵌套 arguments(对象)", normalizeBashParams({ arguments: { command: "date" } }).command === "date");
ok("空对象→空命令", normalizeBashParams({}).command === "");
ok("null→空命令", normalizeBashParams(null).command === "");

console.log("=== resolveTimeoutSec：超时兜底与夹紧 ===");
ok("未传→默认", resolveTimeoutSec(undefined) === DEFAULT_TIMEOUT_SEC);
ok("0→默认", resolveTimeoutSec(0) === DEFAULT_TIMEOUT_SEC);
ok("负数→默认", resolveTimeoutSec(-5) === DEFAULT_TIMEOUT_SEC);
ok("NaN→默认", resolveTimeoutSec("abc") === DEFAULT_TIMEOUT_SEC);
ok("正常值透传", resolveTimeoutSec(30) === 30);
ok("超上限→夹紧", resolveTimeoutSec(9999) === MAX_TIMEOUT_SEC);
ok("字符串数字", resolveTimeoutSec("45") === 45);

console.log("=== assessCommand：危险命令拦截 ===");
// 应拦截
ok("find / 全盘扫描（事故原命令）", assessCommand("find / -maxdepth 5 -name '*.pdf'").blocked === true);
ok("find / 裸根", assessCommand("find /").blocked === true);
ok("find /mnt 系统目录", assessCommand("find /mnt -name x").blocked === true);
ok("find /usr", assessCommand("find /usr/share -name lib").blocked === true);
ok("find /home", assessCommand("find /home -type f").blocked === true);
ok("find C:\\ 盘符根", assessCommand("find C:\\ -name x").blocked === true);
ok("find ~ 家目录", assessCommand("find ~ -name x").blocked === true);
ok("/mnt/data 幻觉路径 ls", assessCommand("ls /mnt/data/knowledge-bases/").blocked === true);
ok("/mnt/data 幻觉路径 cat", assessCommand("cat /mnt/data/x.json").blocked === true);
ok("grep -r /", assessCommand("grep -r foo /").blocked === true);
ok("ls -R /", assessCommand("ls -R /").blocked === true);
// 命中即带原因
ok("拦截含 reason", typeof assessCommand("find /").reason === "string" && assessCommand("find /").reason.length > 0);
ok("拦截含 category", assessCommand("find /").category === "fs-scan-root");

// 应放行（合法命令，勿误杀）
ok("放行 ls", assessCommand("ls -la").blocked === false);
ok("放行项目内 find /c/ 挂载", assessCommand("find /c/WorkSpace/AgentProject -name '*.mjs'").blocked === false);
ok("放行相对 find .", assessCommand("find . -name '*.ts'").blocked === false);
ok("放行 node 脚本", assessCommand("node scripts/kb/lifecycle/kb-update.mjs check").blocked === false);
ok("放行 grep 具体文件", assessCommand("grep -n foo scripts/x.mjs").blocked === false);
ok("放行空命令", assessCommand("").blocked === false);
ok("放行 raw find", assessCommand("find data/raw -name '*.pdf'").blocked === false);

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
