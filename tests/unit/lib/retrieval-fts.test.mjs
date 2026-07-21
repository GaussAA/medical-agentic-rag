// retrieval-fts-test.mjs
// FTS5 trigram 中文候选召回单测：验证「修复 chunks_fts 默认分词器失效」的核心逻辑。
// 运行: node tests/unit/retrieval-fts-test.mjs

import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  lexicalSearch,
  ftsQueryTokens,
  ftsCandidateIds,
  buildFtsIndex,
  ensureFtsIndex,
  sourceSig,
  Database,
} from "../../.pi/extensions/lib/retrieval-router.mjs";

let pass = 0;
let fail = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓", name);
  } else {
    fail++;
    fails.push(name + (extra ? " :: " + extra : ""));
    console.log("  ✗", name, extra);
  }
}

const TMP = mkdtempSync(join(tmpdir(), "fts-test-"));
const SRC = join(TMP, "src.db");
const FTS = join(TMP, "fts.db");

// 源库（完整 chunks schema，含 kb_id / indexed_at，贴近 knowledge.db）
const src = new Database(SRC);
src.exec(
  "CREATE TABLE chunks (id TEXT PRIMARY KEY, kb_id TEXT NOT NULL, content TEXT NOT NULL, content_tokenized TEXT, file_path TEXT NOT NULL, metadata_json TEXT DEFAULT '{}', indexed_at INTEGER NOT NULL)",
);
const ins = src.prepare(
  "INSERT INTO chunks (id, kb_id, content, file_path, indexed_at) VALUES (?, ?, ?, ?, ?)",
);
const KB = "kb1";
ins.run("c1", KB, "高血压的诊断与长期管理方案，推荐低盐饮食与规律运动。", "高血压指南.md", 100);
ins.run("c2", KB, "糖尿病的血糖管理，胰岛素治疗与饮食控制。", "糖尿病指南.md", 200);
// 干扰项：与查询无 3 字重叠，仅含 2 字「管理」——用于证明 FTS 收窄（非全扫）
ins.run("c3", KB, "肺炎的抗生素治疗与护理管理，注意肺部感染。", "肺炎指南.md", 300);
ins.run("c4", KB, "骨折的术后康复管理，早期活动预防血栓。", "骨折指南.md", 400);

console.log("\n[1] ftsQueryTokens — 3+ 字滑窗，2 字丢弃");
{
  const t = ftsQueryTokens("高血压 管理"); // 高血压(3) 管理(2,弃)
  ok("抽取到 3 字词元 高血压", t.includes("高血压"), JSON.stringify(t));
  ok("丢弃 2 字 管理", !t.includes("管理"), JSON.stringify(t));
  const t2 = ftsQueryTokens("高血压糖尿病"); // 重叠滑窗
  ok("长串生成滑窗(高血压/糖尿病均在)", t2.includes("高血压") && t2.includes("糖尿病"), JSON.stringify(t2));
  ok("纯 2 字查询返回空→降级全扫", ftsQueryTokens("肺炎").length === 0);
}

console.log("\n[2] buildFtsIndex + ftsCandidateIds — trigram 召回");
const fts = new Database(FTS);
buildFtsIndex(src, fts, "4:400");
{
  const ids = ftsCandidateIds(fts, "高血压 管理");
  ok("高血压查询召回 c1", ids && ids.includes("c1"), JSON.stringify(ids));
  ok("不召回无关 c3/c4(无 3 字词元命中)", ids && !ids.includes("c3") && !ids.includes("c4"), JSON.stringify(ids));
  const ids2 = ftsCandidateIds(fts, "糖尿病");
  ok("糖尿病查询召回 c2", ids2 && ids2.includes("c2"));
  ok("2 字查询返回 null→降级全扫", ftsCandidateIds(fts, "肺炎") === null);
}

console.log("\n[3] lexicalSearch — FTS 收窄验证（对照全扫证明非全表）");
{
  const r = lexicalSearch(src, "高血压 管理", { ftsDb: fts, limit: 8 });
  ok("高血压排首且为 c1", r.length >= 1 && r[0].file_path === "高血压指南.md", JSON.stringify(r.map((x) => x.file_path)));
  ok("FTS 收窄：干扰项 c4(仅 2 字重叠) 未进入候选", r.every((x) => x.file_path !== "骨折指南.md"), JSON.stringify(r.map((x) => x.file_path)));

  // 对照：FTS 不可用（空库）→ 降级全扫，会召回 c4（管理 2 字命中，低分）
  const empty = new Database(join(TMP, "empty.db"));
  const full = lexicalSearch(src, "高血压 管理", { ftsDb: empty });
  ok("全扫对照含 c4(管理 2 字命中)", full.some((x) => x.file_path === "骨折指南.md"), JSON.stringify(full.map((x) => x.file_path)));
  empty.close();
}

console.log("\n[4] 降级正确性 — 2 字查询仍可用（全扫兜底）");
{
  const r = lexicalSearch(src, "肺炎", { ftsDb: fts });
  ok("肺炎(2 字)全扫召回 c3", r.length >= 1 && r.some((x) => x.file_path === "肺炎指南.md"), JSON.stringify(r.map((x) => x.file_path)));
}

console.log("\n[5] ensureFtsIndex — 惰性构建 + 失效重建");
{
  const db1 = ensureFtsIndex(src, FTS);
  ok("ensureFtsIndex 返回连接", !!db1);
  const sig1 = db1.prepare("SELECT v FROM meta WHERE k='sig'").get().v;
  ok("meta sig 与 sourceSig 一致", sig1 === sourceSig(src), sig1);
  // 新增 chunk 致 sig 变化 → 重建
  ins.run("c5", KB, "高血压危象的急诊处理流程与降压方案。", "高血压指南.md", 500);
  const db2 = ensureFtsIndex(src, FTS);
  const ids = ftsCandidateIds(db2, "高血压危象");
  ok("失效后重建，新词元召回 c5", ids && ids.includes("c5"), JSON.stringify(ids));
}

console.log("\n[6] 失效重建 — 内容变更而 COUNT/MAX(indexed_at) 不变（签名漂移回归·长度指纹）");
{
  // 前置：c1 当前为「高血压」内容，FTS 已索引。现仅改 c1 正文（保持 indexed_at=100），
  // 行数与 MAX(indexed_at) 均不变 —— 旧签名（仅 COUNT:MAX）会判定「无需重建」致索引漂移。
  const db3 = ensureFtsIndex(src, FTS);
  const before = ftsCandidateIds(db3, "高血压");
  ok("改前 FTS 含 c1(高血压)", before && before.includes("c1"), JSON.stringify(before));

  // 改为不同长度的新正文（急性心肌梗死…），仅 c1 正文长度/文本变化，行数与时间戳不变
  src
    .prepare("UPDATE chunks SET content=? WHERE id='c1'")
    .run("急性心肌梗死的再灌注治疗策略与并发症防治要点。");
  const db4 = ensureFtsIndex(src, FTS); // 内容总长指纹变化 → 签名变 → 触发重建
  ok("内容变更后 ensureFtsIndex 仍返回连接", !!db4);

  const afterOld = ftsCandidateIds(db4, "高血压");
  ok("旧词元 高血压 不再召回 c1（内容已替换）", afterOld && !afterOld.includes("c1"), JSON.stringify(afterOld));
  const afterNew = ftsCandidateIds(db4, "心肌梗死");
  ok("新词元 心肌梗死 召回 c1（FTS 已重建）", afterNew && afterNew.includes("c1"), JSON.stringify(afterNew));
}

console.log("\n[7] 失效重建 — 等长改写但刷新 indexed_at（双保险·时间戳路径）");
{
  // 模拟外部写入：正文等长替换且刷新 indexed_at（MAX 变化）→ 签名变 → 重建。
  // 验证即便长度指纹未变，MAX(indexed_at) 仍能兜住（rebuild-kb 每次 upsert 须刷新时间戳）。
  const db5 = ensureFtsIndex(src, FTS);
  src
    .prepare("UPDATE chunks SET content=?, indexed_at=99999 WHERE id='c2'")
    .run("甲亢的药物剂量调整与随访监测指标解读。");
  const db6 = ensureFtsIndex(src, FTS);
  const r = ftsCandidateIds(db6, "药物剂量");
  ok("刷新时间戳后 FTS 重建并召回 c2(药物剂量)", r && r.includes("c2"), JSON.stringify(r));
  const rOld = ftsCandidateIds(db6, "糖尿病");
  ok("旧词元 糖尿病 不再召回 c2", rOld && !rOld.includes("c2"), JSON.stringify(rOld));
}

fts.close();
src.close();
console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail) console.log("失败项:", fails);
try {
  rmSync(TMP, { recursive: true, force: true });
} catch {}
process.exit(fail ? 1 : 0);
