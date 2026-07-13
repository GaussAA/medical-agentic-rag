// scripts/kb/add_oversized.mjs
// 增量刷新「医疗指南」KB：knowledge_update 重扫其 retained source (raw 含 _oversized_split 子目录)，
// 收录 331 个子块（罕见病/乳腺癌/肝癌拆分补录），消除原 3 份 oversized 的覆盖空洞。
// 为何不用 knowledge_add：add 是"创建新 KB"语义，KB 已存在会报 already exists。
// 可逆：rebuild-kb.mjs 可从 raw 整体重建并自动包含 _oversized_split 子块。
// 用法：node scripts/kb/add_oversized.mjs
import { pathToFileURL } from "node:url";
import { join } from "node:path";

const npmRoot =
  process.env.PI_AGENT_NPM ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm");
const PK_URL = pathToFileURL(
  join(npmRoot, "node_modules/pi-knowledge/dist/index.js")
).href;

const NAME = "医疗指南";

const pk = (await import(PK_URL)).default;
const captured = {};
const mockPi = {
  on: () => {},
  registerTool: (d) => {
    captured[d.name] = d;
  },
  registerCommand: () => {},
};
pk(mockPi);

const need = ["knowledge_status", "knowledge_update"];
for (const n of need) {
  if (!captured[n]) throw new Error(`未捕获工具 ${n}`);
}

const su = (r) => {
  const c = r && r.content && r.content[0];
  return c && c.text ? c.text : JSON.stringify(r);
};
const logUpdate = (u) => {
  const t = u && u.content && u.content[0] && u.content[0].text;
  if (t) console.log("[progress]", t);
};

console.log("=== ① 刷新前 KB 状态 ===");
console.log(su(await captured["knowledge_status"].execute("knowledge_status", {}, null)));

console.log(`\n=== ② 增量刷新 KB「${NAME}」（重扫 raw 含 _oversized_split 子目录，收录 331 子块）===`);
console.log("（将加载 e5 嵌入模型并逐块索引，请耐心等待滚动进度）");
const upRes = await captured["knowledge_update"].execute(
  "knowledge_update",
  { target: NAME },
  null,
  logUpdate
);
console.log("UPDATE RESULT:", su(upRes));

console.log("\n=== ③ 刷新后 KB 状态 ===");
console.log(su(await captured["knowledge_status"].execute("knowledge_status", {}, null)));

console.log("\n=== 刷新脚本结束，强制退出（释放 watcher 句柄）===");
process.exit(0);
