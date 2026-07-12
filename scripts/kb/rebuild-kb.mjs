// 重建知识库：增量优先，全量可选。
// 默认（无参数）：knowledge_update 增量同步 retained source(medical-raw)，只加新/删源无/留未变 —— 省 20~40 分钟。
//   engine.update 返回 {added, removed, unchanged}，即真增量 diff（对应大帅「为何每次全量」之问）。
// --full：knowledge_clear + knowledge_add 全量重建（库损坏/大改时用，保留兜底）。
// 注意：pi-knowledge 对 >~10MB 文件硬性 oversized skip（knowledge_plan 实测 {oversized:3}），
//   故三份 oversized 主 PDF 须先拆为小页 PDF（scripts/kb/split_oversized.py）方可被增量纳入。
// 用法：node scripts/kb/rebuild-kb.mjs [--full]
import { pathToFileURL } from "node:url";

const PK_URL = pathToFileURL(
  "C:/Users/JaNiy/.pi/agent/npm/node_modules/pi-knowledge/dist/index.js"
).href;

const SOURCE = "C:/WorkSpace/AgentProject/medical-agentic-rag/medical-raw";
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

console.log("\n=== 脚本结束，强制退出（释放 watcher 句柄）===");
process.exit(0);
