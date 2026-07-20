// 由盘上真实原始文档反推重建 kb-sources.json（去重、归类、对齐）
// 方案 B：源真相为 raw/ 下的 PDF/DOCX（不再有 MD 中间层）。
// 修正：contentHash 对真实原始文件字节求 sha256（旧版传空串等于没算指纹）。
import { readdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const RAW = join(ROOT, "data", "raw");
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const kb = await import(MOD);

function rawHash(p) {
  const buf = readFileSync(p);
  return createHash("sha256").update(buf).digest("hex");
}

const files = readdirSync(RAW)
  .filter((f) => /\.(pdf|docx|txt)$/i.test(f) && !/\.nhc_tmp_/i.test(f))
  .filter((f) => statSync(join(RAW, f)).isFile())
  .sort();

const out = files.map((f) => {
  const ext = extname(f).toLowerCase();
  const n = f.slice(0, -ext.length);
  const p = join(RAW, f);
  return {
    id: n, name: n, type: "local",
    localPath: `data\raw\\${f}`,
    cadenceDays: 30, validate: "sha256",
    department: kb.inferDepartment(n),
    lastChecked: new Date().toISOString(),
    lastHash: rawHash(p),
    note: "原始文档直供·大帅源目录同步（方案B：弃MD中间层）",
  };
});
writeFileSync(
  join(ROOT, "data/kb/kb-sources.json"),
  JSON.stringify({ sources: out, meta: { lastFullCheck: new Date().toISOString() } }, null, 2),
  "utf-8"
);
console.log("registry rebuilt:", out.length, "sources (from raw/)");
