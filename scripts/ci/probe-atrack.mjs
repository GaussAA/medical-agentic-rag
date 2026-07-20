// 定向检索探针：验证 A 轨新指南是否已真入向量库并可被 searchKnowledge 召回。
// 用法（须托管 node22 + 剥离 WorkBuddy safe-delete 守护）：
//   NODE_OPTIONS="--use-system-ca" PI_AGENT_NPM=... USERPROFILE=... node22 scripts/ops/probe-atrack.mjs
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmRoot =
  process.env.PI_AGENT_NPM ||
  join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm");
const PK_URL = pathToFileURL(
  join(npmRoot, "node_modules/pi-knowledge/dist/index.js")
).href;

const pk = (await import(PK_URL)).default;
const captured = {};
pk({
  on: () => {},
  registerTool: (d) => {
    captured[d.name] = d;
  },
  registerCommand: () => {},
});
console.log("[tools]", Object.keys(captured).join(", "));

const tool = captured["searchKnowledge"];
if (!tool) {
  console.error("[FAIL] 无 searchKnowledge 工具");
  process.exit(1);
}

const QUERIES = [
  "严重过敏反应 肾上腺素 抢救",
  "易栓症 抗凝 治疗",
  "幽门螺杆菌 根除 方案",
  "妊娠期高血糖 胰岛素",
];

for (const q of QUERIES) {
  const shapes = [
    { query: q, kb: "医疗指南", topK: 3 },
    { q, knowledgeBase: "医疗指南", k: 3 },
    { query: q, knowledgeBase: "医疗指南", topK: 3 },
  ];
  let hit = null;
  for (const arg of shapes) {
    try {
      const res = await tool.execute("searchKnowledge", arg, null);
      const t = res?.content?.[0]?.text || JSON.stringify(res);
      if (t && t.length > 20) {
        hit = t;
        break;
      }
    } catch (e) {
      /* try next shape */
    }
  }
  if (hit) {
    console.log(`\n=== Q: ${q} ===`);
    console.log(hit.slice(0, 500));
  } else {
    console.log(`\n=== Q: ${q} === (无召回)`);
  }
}
process.exit(0);
