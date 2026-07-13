// 重建知识库：增量优先，全量可选。
// 默认（无参数）：knowledge_update 增量同步 retained source(raw)，只加新/删源无/留未变 —— 省 20~40 分钟。
//   engine.update 返回 {added, removed, unchanged}，即真增量 diff（对应大帅「为何每次全量」之问）。
// --full：knowledge_clear + knowledge_add 全量重建（库损坏/大改时用，保留兜底）。
// 注意：pi-knowledge 对 >~10MB 文件硬性 oversized skip（knowledge_plan 实测 {oversized:3}），
//   故三份 oversized 主 PDF 须先拆为小页 PDF（scripts/kb/split_oversized.py）方可被增量纳入。
// 用法：node scripts/kb/rebuild-kb.mjs [--full]
import { pathToFileURL, fileURLToPath } from "node:url";
import { join, dirname } from "node:path";

// ---- 并发安全：SQLite WAL 模式 + busy_timeout ----
// 确保 KB 写入期间多实例读操作不阻塞。WAL 模式下读写不互斥，
// busy_timeout=5000 使写冲突时自动重试 5s 而非立即抛 SQLITE_BUSY。
try {
  const { createRequire } = await import("node:module");
  const require = createRequire(import.meta.url);
  const Database = require("better-sqlite3");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  const dbPath = join(home, ".pi", "knowledge", "knowledge.db");
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("busy_timeout = 5000");
  db.close();
  console.log("[sqlite] WAL 模式已启用 / busy_timeout=5000");
} catch (e) {
  console.warn("[sqlite] 未能设置 WAL 模式（数据库可能尚未创建）:", e?.message || e);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmRoot =
  process.env.PI_AGENT_NPM ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm");
const PK_URL = pathToFileURL(
  join(npmRoot, "node_modules/pi-knowledge/dist/index.js")
).href;

const SOURCE = join(ROOT, "data", "raw");
const NAME = "医疗指南";
const FULL = process.argv.includes("--full");

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

const need = FULL
  ? ["knowledge_status", "knowledge_clear", "knowledge_add"]
  : ["knowledge_status", "knowledge_update"];
for (const n of need) {
  if (!captured[n]) throw new Error(`未捕获工具 ${n}`);
}

function tx(res) {
  const c = res && res.content && res.content[0];
  return c && c.text ? c.text : JSON.stringify(res);
}
function logUpdate(u) {
  const t = u && u.content && u.content[0] && u.content[0].text;
  if (t) console.log("[progress]", t);
}

console.log(`=== 重建模式：${FULL ? "全量(clear+add)" : "增量(update)"} ===`);
console.log("=== ① 重建前 KB 状态 ===");
console.log(tx(await captured["knowledge_status"].execute("knowledge_status", {}, null)));

if (FULL) {
  console.log("\n=== ② [全量] 清空旧 KB ===");
  console.log(tx(await captured["knowledge_clear"].execute("knowledge_clear", { confirm: true }, null)));
  console.log(`\n=== ③ [全量] 重建：索引 ${SOURCE} → KB「${NAME}」 ===`);
  console.log("（首次会加载 e5 嵌入模型，可能静默 1~2 分钟，随后滚动进度）");
  const addRes = await captured["knowledge_add"].execute(
    "knowledge_add",
    { source: SOURCE, name: NAME, include_suggested_text: true },
    null,
    logUpdate
  );
  console.log("ADD RESULT:", tx(addRes));
} else {
  console.log(`\n=== ② [增量] 同步 KB「${NAME}」（重扫 ${SOURCE}，+加新 / -删源无 / 留未变）===`);
  const upRes = await captured["knowledge_update"].execute(
    "knowledge_update",
    { target: NAME },
    null,
    logUpdate
  );
  console.log("UPDATE RESULT:", tx(upRes));
}

console.log("\n=== ④ 重建后 KB 状态 ===");
console.log(tx(await captured["knowledge_status"].execute("knowledge_status", {}, null)));

// ---- 清空检索缓存，使 KB 变更立即生效 ----
try {
  const { cacheClear } = await import("../../.pi/extensions/lib/retrieval-cache.mjs");
  cacheClear();
  console.log("[cache] 检索缓存已清空");
} catch (e) {
  console.warn("[cache] 清空缓存失败:", e?.message || e);
}

console.log("\n=== 脚本结束，强制退出（释放 watcher 句柄）===");
process.exit(0);
