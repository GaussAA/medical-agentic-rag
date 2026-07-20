// build-retrieval-fts.mjs
// 预热/重建检索层 FTS5 trigram 中文候选召回索引（.pi/cache/retrieval-fts.db）。
//
// 背景：retrieval-router 的 lexicalSearch 默认惰性建索引（首次查询时触发，约数百 ms~数秒）。
// 本脚本用于运维预热——在服务启动前先建好，避免首个用户查询承担建索引开销；
// 也用于手动强制重建（如 knowledge.db 大版本变更后 sig 未命中时，运行期会自动重建，本脚本为显式路径）。
//
// 运行: npm run kb:fts

import { Database, ensureFtsIndex, ftsDbPath, resolveKbDbPath } from "../../../.pi/extensions/lib/retrieval-router.mjs";

const p = resolveKbDbPath();
if (!p) {
  console.error("[kb:fts] 未找到 knowledge.db（PI_KNOWLEDGE_DIR / ~/.pi/knowledge 均无）");
  process.exit(1);
}

console.log("[kb:fts] 源库:", p);
const t0 = Date.now();
const src = new Database(p, { readonly: true, fileMustExist: true });
const fts = ensureFtsIndex(src);
if (!fts) {
  console.error("[kb:fts] FTS 索引构建失败（详见上方错误，已降级全扫）");
  try { src.close(); } catch {}
  process.exit(1);
}
const ms = Date.now() - t0;
console.log(`[kb:fts] FTS 索引就绪：${ftsDbPath()}（耗时 ${ms}ms）`);
try { fts.close(); } catch {}
try { src.close(); } catch {}
