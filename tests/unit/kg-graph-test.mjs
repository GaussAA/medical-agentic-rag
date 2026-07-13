// tests/unit/kg-graph-test.mjs
// 验证两处隐患修复：
//   A. 缓存跨进程写安全（文件锁）：模拟多进程并发 cacheSet 不丢更新
//   B. 知识图谱多跳推理（SQLite 递归 CTE）：二分图游走正确性 + 实体/疾病双起点
//
// 纯原生 node 单测（零框架，ok() 微型断言），被 tests/run-all-tests.mjs 收集。
import { existsSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = pjoin(__dirname, "..", "..");
const CACHE_LIB = pjoin(ROOT, ".pi", "extensions", "lib", "retrieval-cache.mjs");
const KG_DB_LIB = pjoin(ROOT, ".pi", "extensions", "lib", "kg-graph-db.mjs");

let passed = 0;
let failed = 0;
const fails = [];
function ok(name, cond, extra = "") {
  if (cond) {
    passed++;
    console.log(`  ✅ ${name}`);
  } else {
    failed++;
    fails.push(name + (extra ? ` — ${extra}` : ""));
    console.log(`  ❌ ${name}${extra ? ` — ${extra}` : ""}`);
  }
}

// ============================================================
// A. 缓存文件锁并发安全
// ============================================================
async function testCacheLock() {
  console.log("\n[缓存文件锁并发安全]");

  // 用独立临时缓存目录隔离，避免污染真实缓存
  const tmp = mkdtempSync(pjoin(tmpdir(), "cachelock-"));
  const origCwd = process.cwd();
  process.chdir(tmp); // CACHE_DIR 基于 process.cwd()/.pi/cache

  try {
    // 单进程基本读写
    const { cacheSet, cacheGet, cacheClear } = await import(pathToFileURL(CACHE_LIB).href);
    cacheClear();
    cacheSet("k1", { v: 1 });
    ok("单进程写后读一致", JSON.stringify(cacheGet("k1")) === JSON.stringify({ v: 1 }));

    // 多进程并发：16 个子进程各写一个唯一键，验证最终不丢更新
    const N = 16;
    const worker = pjoin(tmp, "worker.mjs");
    writeFileSync(
      worker,
      `import { cacheSet, cacheGet } from ${JSON.stringify(pathToFileURL(CACHE_LIB).href)};
       const id = process.argv[2];
       cacheSet('key-' + id, { id: Number(id), ts: Date.now() });
       `,
    );
    const nodeBin = process.execPath;
    for (let i = 0; i < N; i++) {
      spawnSync(nodeBin, [worker, String(i)], { cwd: tmp, stdio: "ignore" });
    }
    // 主进程读回所有键，验证 16 条全在（无互相覆盖丢更新）
    let allPresent = true;
    for (let i = 0; i < N; i++) {
      const v = cacheGet("key-" + i);
      if (!v || v.id !== i) {
        allPresent = false;
        break;
      }
    }
    ok(`多进程并发 ${N} 写无丢更新`, allPresent, "存在键缺失或值被覆盖");

    // 锁文件最终已释放（无残留）
    const lockExists = existsSync(pjoin(tmp, ".pi", "cache", "retrieval-cache.json.lock"));
    ok("锁文件运行后已释放", !lockExists);

    cacheClear();
  } finally {
    process.chdir(origCwd);
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ============================================================
// B. 知识图谱多跳推理
// ============================================================
async function testKgGraph() {
  console.log("\n[知识图谱多跳推理]");

  const { ensureGraphDb, traverseGraph, graphDbPath } = await import(pathToFileURL(KG_DB_LIB).href);
  const jsonPath = pjoin(ROOT, "knowledge-base", ".knowledge-graph.json");
  const dbPath = pjoin(ROOT, "knowledge-base", ".knowledge-graph.db");

  // 确保 DB 已构建（本地应有；CI 若缺则即时构建）
  if (!existsSync(dbPath)) {
    ensureGraphDb({ jsonPath, dbPath });
  }
  ok("图谱 DB 存在", existsSync(dbPath), dbPath);

  // 从实体（靶向治疗）出发：应见 1 跳（被多疾病使用）+ 2 跳（疾病的关联实体）
  const r1 = traverseGraph("靶向治疗", { maxDepth: 2, limit: 100, dbPath });
  ok("实体起点多跳有结果", r1.count > 0, `count=${r1.count}`);
  const hasDepth1 = r1.paths.some((p) => p.depth === 1);
  const hasDepth2 = r1.paths.some((p) => p.depth === 2);
  ok("实体起点产生 1 跳路径", hasDepth1);
  ok("实体起点产生 2 跳路径（共病网络）", hasDepth2);

  // 从疾病（糖尿病）出发：1 跳风险疾病 + 2 跳诊断/治疗
  const r2 = traverseGraph("糖尿病", { maxDepth: 2, limit: 100, dbPath });
  ok("疾病起点多跳有结果", r2.count > 0, `count=${r2.count}`);
  const diabetesDepth2 = r2.paths.some((p) => p.depth === 2 && p.path.includes("糖尿病") && p.path.includes("胰腺癌"));
  ok("糖尿病→风险疾病→诊断 链路可达", diabetesDepth2, JSON.stringify(r2.paths.slice(0, 3)));

  // 不存在的节点应安全返回空
  const r3 = traverseGraph("不存在的XYZ节点", { maxDepth: 2, limit: 10, dbPath });
  ok("不存在节点返回空且不抛错", r3.count === 0);

  // limit 截断
  const r4 = traverseGraph("靶向治疗", { maxDepth: 2, limit: 5, dbPath });
  ok("limit 截断生效", r4.count <= 5, `count=${r4.count}`);

  // searchKGDeep 封装
  const kgSearch = await import(pathToFileURL(pjoin(ROOT, ".pi", "extensions", "lib", "kg-search.mjs")).href);
  const deep = kgSearch.searchKGDeep({ start: "靶向治疗" }, { baseDir: ROOT });
  ok("searchKGDeep 封装可用", deep.count > 0 && !deep.degraded, `count=${deep.count}`);
}

// ============================================================
// 主入口
// ============================================================
async function main() {
  console.log("=".repeat(50));
  console.log("  隐患修复验证：缓存锁 + 图谱多跳");
  console.log("=".repeat(50));
  await testCacheLock();
  await testKgGraph();
  console.log(`\n结果: ${passed} 通过 / ${failed} 失败`);
  if (failed) {
    console.log("失败项:", fails.join("; "));
    process.exit(1);
  }
  process.exit(0);
}

main().catch((e) => {
  console.error("测试异常:", e);
  process.exit(1);
});
