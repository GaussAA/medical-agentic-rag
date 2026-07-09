// 由盘上真实 MD 反推重建 kb-sources.json（去重、归类、对齐）
import { readdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const KB = join(ROOT, "medical-knowlegde-base");
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const kb = await import(MOD);
const files = readdirSync(KB).filter((f) => f.endsWith(".md") && !f.startsWith("."));
const out = files.map((f) => {
  const n = f.slice(0, -3);
  return {
    id: n, name: n, type: "local",
    localPath: `medical-knowlegde-base\\${n}.md`,
    cadenceDays: 30, validate: "sha256",
    department: kb.inferDepartment(n),
    lastChecked: new Date().toISOString(), lastHash: kb.contentHash(""),
    note: "批量统一·大帅原始文档直供",
  };
});
writeFileSync(join(ROOT, "kb-sources.json"), JSON.stringify({ sources: out, meta: { lastFullCheck: new Date().toISOString() } }, null, 2), "utf-8");
console.log("registry rebuilt:", out.length, "sources");
