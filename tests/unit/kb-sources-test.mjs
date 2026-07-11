// kb-sources-test.mjs
// 知识库来源管理单测 —— 验证登记/内容指纹/过期判定/快照回滚/摄取。
// 原生 node 运行，隔离临时目录，不污染项目真实 kb-sources.json。运行：node tests/kb-sources-test.mjs

import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const origCwd = process.cwd();
const workdir = mkdtempSync(join(tmpdir(), "kbs-test-"));
process.chdir(workdir);

const MOD = pathToFileURL(join(origCwd, ".pi/extensions/lib/kb-sources.mjs")).href;
const kb = await import(MOD);

let passed = 0, failed = 0;
const results = [];
function check(name, cond, detail = "") {
  if (cond) { passed++; results.push({ name, ok: true }); console.log(`  ✓ ${name}`); }
  else { failed++; results.push({ name, ok: false, detail }); console.log(`  ✗ ${name}  ${detail}`); }
}

// 构造隔离 registry
const REG = join(workdir, "kb-sources.json");
const localFile = join(workdir, "guide.md");
writeFileSync(localFile, "# 测试指南\n内容A", "utf-8");
const registry = {
  meta: {},
  sources: [
    { id: "g1", name: "指南A", type: "local", localPath: localFile, cadenceDays: 7, lastChecked: new Date().toISOString() },
    { id: "web1", name: "外部B", type: "web", url: "https://example.com/b", cadenceDays: 30 },
  ],
};
writeFileSync(REG, JSON.stringify(registry, null, 2), "utf-8");

console.log("\n=== 知识库来源管理单测 ===\n");

// 1. loadRegistry
console.log("[1] 登记读取");
const reg = kb.loadRegistry(REG);
check("读出 2 项", reg.sources.length === 2);
check("local 项带 localPath", reg.sources[0].localPath === localFile);

// 2. contentHash 稳定 + 不同内容不同
console.log("\n[2] 内容指纹");
const hA = kb.contentHash("# 测试指南\n内容A");
const hB = kb.contentHash("# 测试指南\n内容B");
check("相同内容 hash 一致", hA === kb.contentHash("# 测试指南\n内容A"));
check("不同内容 hash 不同", hA !== hB);
check("空内容哨兵", kb.contentHash("") === "EMPTY");

// 3. ingest local 真实指纹
console.log("\n[3] ingest local");
const r1 = await kb.ingest(reg.sources[0]);
check("local 摄取成功(ingested=true)", r1.ingested === true);
check("指纹与内容一致", r1.hash === hA);

// 4. ingest local 缺失文件 → error
console.log("\n[4] ingest 缺失文件");
const missing = { id: "x", type: "local", localPath: join(workdir, "nope.md") };
const r2 = await kb.ingest(missing);
check("缺失 → error=true", r2.error === true);
check("hash=MISSING", r2.hash === "MISSING");

// 5. ingest web → 未实现（不误报成功）
console.log("\n[5] ingest web 未实现");
const r3 = await kb.ingest(reg.sources[1]);
check("web 不误报 ingested", r3.ingested === false);
check("含未实现说明", r3.reason.includes("未实现"));

// 6. staleness
console.log("\n[6] 过期判定");
check("刚检查≠过期", kb.isStale(reg.sources[0]) === false);
const old = { ...reg.sources[0], lastChecked: new Date(Date.now() - 1000 * 60 * 60 * 24 * 365).toISOString() };
check("一年前检查=过期", kb.isStale(old) === true);
const fresh = await kb.ingest; // noop
const staleSet = kb.checkStaleness({ sources: [old, reg.sources[1]] });
check("checkStaleness 分桶正确", staleSet.stale.length === 2 && staleSet.fresh.length === 0);

// 7. snapshot + rollback
console.log("\n[7] 快照与回滚");
const snapPath = kb.snapshot(REG);
check("快照文件生成", existsSync(snapPath));
// 篡改 registry 再回滚
writeFileSync(REG, JSON.stringify({ sources: [{ id: "tampered" }] }, null, 2), "utf-8");
kb.rollback(snapPath);
const restored = kb.loadRegistry(REG);
check("回滚恢复 2 项", restored.sources.length === 2);
check("回滚恢复原始 id", restored.sources[0].id === "g1");

// 8. refreshAll 不破坏 registry 且标注 lastChecked
console.log("\n[8] refreshAll");
const res = await kb.refreshAll({ file: REG });
check("refresh 流程 ok", res.ok === true);
const after = kb.loadRegistry(REG);
check("local 项被标 lastChecked", Boolean(after.sources[0].lastChecked));
check("local 项指纹已写入", after.sources[0].lastHash === hA);

console.log(`\n=== 结果 ===\n通过 ${passed} / ${passed + failed}`);

// 9. 覆盖度分析（偏科感知）
console.log("\n[9] 覆盖度分析 computeCoverage");
const cov = kb.computeCoverage({
  sources: [
    { name: "肺癌诊疗指南", department: "肿瘤" },
    { name: "乳腺癌诊疗指南", department: "肿瘤" },
    { name: "胃癌诊疗指南", department: "肿瘤" },
    { name: "儿童肺炎指南", department: "儿科" },
  ],
});
check("总数 4", cov.total === 4);
check("肿瘤 3 占比 75%", cov.byDept[0].dept === "肿瘤" && cov.byDept[0].pct === 0.75);
check("偏科指数=最高占比", Math.abs(cov.imbalance - 0.75) < 1e-9);
check("缺口含缺失专科", cov.gaps.includes("急诊") && cov.gaps.includes("心血管"));
check("缺口不含已覆盖儿科/肿瘤", !cov.gaps.includes("儿科") && !cov.gaps.includes("肿瘤"));

// 10. inferDepartment 关键词归类
console.log("\n[10] inferDepartment 归类");
check("肺癌→肿瘤", kb.inferDepartment("原发性肺癌诊疗指南（2024）") === "肿瘤");
check("血友病→血液", kb.inferDepartment("血友病A诊疗指南") === "血液");
check("儿童→儿科", kb.inferDepartment("儿童急性淋巴细胞白血病规范") === "儿科");
check("急救→急诊", kb.inferDepartment("常见急危重症诊疗规范") === "急诊");
check("妊娠→产科", kb.inferDepartment("妊娠期高血压疾病指南") === "产科");
check("未知→其他内科", kb.inferDepartment("某某综合处置原则") === "其他内科");

// 11. GAP_CATALOG 候选目录
console.log("\n[11] 缺口候选目录 GAP_CATALOG");
check("目录非空", Array.isArray(kb.GAP_CATALOG) && kb.GAP_CATALOG.length >= 10);
check("每条含 dept/name/hint", kb.GAP_CATALOG.every((g) => g.dept && g.name && g.hint));

process.chdir(origCwd);
try { rmSync(workdir, { recursive: true, force: true }); } catch {}

const report = { suite: "kb-sources", ts: new Date().toISOString(), passed, failed, total: passed + failed, results };
mkdirSync(join(origCwd, "tests"), { recursive: true });
writeFileSync(join(origCwd, "tests", "kb-sources-report.json"), JSON.stringify(report, null, 2), "utf-8");
console.log("报告: tests/kb-sources-report.json");
process.exit(failed === 0 ? 0 : 1);
