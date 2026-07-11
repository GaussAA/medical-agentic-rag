// 重建知识库：清空旧 KB（30 份已删 MD 快照）→ 从 medical-raw/ 的 135 份原始文档重新向量化索引。
// 复用 pi-knowledge 自带工具链（knowledge_clear / knowledge_add），零自造 chunk/embed 逻辑。
// 用法：node scripts/kb/rebuild-kb.mjs
import { pathToFileURL } from "node:url";

const PK_URL = pathToFileURL(
  "C:/Users/JaNiy/.pi/agent/npm/node_modules/pi-knowledge/dist/index.js"
).href;

const SOURCE = "C:/WorkSpace/AgentProject/medical-agentic-rag/medical-raw";
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

const need = ["knowledge_status", "knowledge_clear", "knowledge_add"];
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

console.log("=== ① 重建前 KB 状态 ===");
console.log(tx(await captured["knowledge_status"].execute("knowledge_status", {}, null)));

console.log("\n=== ② 清空旧 KB（含 27 份已删 MD 快照 + 派生索引文件）===");
console.log(tx(await captured["knowledge_clear"].execute("knowledge_clear", { confirm: true }, null)));

console.log(`\n=== ③ 重建：索引 ${SOURCE} → KB「${NAME}」 ===`);
console.log("（首次重建会加载 e5 嵌入模型，可能静默 1~2 分钟，随后开始滚动进度）");
const addRes = await captured["knowledge_add"].execute(
  "knowledge_add",
  { source: SOURCE, name: NAME, include_suggested_text: true },
  null,
  logUpdate
);
console.log("ADD RESULT:", tx(addRes));

console.log("\n=== ④ 重建后 KB 状态 ===");
console.log(tx(await captured["knowledge_status"].execute("knowledge_status", {}, null)));

console.log("\n=== 重建脚本结束，强制退出（释放 watcher 句柄）===");
process.exit(0);
