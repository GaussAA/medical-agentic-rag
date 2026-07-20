#!/usr/bin/env node
// ============================================================
// fill-gaps.mjs — KB 知识缺口补录工具
//
// 检测 KB 中缺失的指南病种，从开放获取源（Europe PMC / NCBI）
// 尝试获取缺失的指南文本，输出到 data/raw-txt/ 等待下一步
// kb:prepare → kb:outline → kb:index → kb:rebuild 纳入索引。
//
// 用法：
//   node scripts/kb/fill-gaps.mjs                          # 检测+补录全部
//   node scripts/kb/fill-gaps.mjs --detect-only            # 仅检测缺口
//   node scripts/kb/fill-gaps.mjs --source pmc             # 仅从 PMC 补录
//
// 输出：
//   data/kb/gap-report.json — 缺口检测报告
//   data/raw-txt/*.txt       — 补录得到的指南文本（待后续 kb:prepare 处理）
// ============================================================
import { readFileSync, existsSync, writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..", "..");
const KB_DIR = join(ROOT, "data", "kb");
const RAW_DIR = join(ROOT, "data", "raw-txt");
const GAP_FILE = join(KB_DIR, "gap-report.json");

// 已知知识缺口（按优先级排序）
// 来源：项目记忆 + 病种覆盖检查
const GAP_SOURCES = [
  // ---- 已确认开放获取的缺口 ----
  {
    id: "cirrhosis-2025",
    disease: "肝硬化",
    title: "肝硬化临床诊治管理指南(2025版)",
    year: "2025",
    pmcId: "PMC12861852",
    priority: 1,
    reason: "当前 KB 仅有 2019 版肝硬化指南",
  },
  // ---- 需尝试 PMC 搜索的缺口 ----
  // 2型糖尿病2025 - 可能在中国糖尿病杂志或 Europe PMC
  // 神经核心指南 - 多个神经疾病指南
  // 产后出血 - 已有但需确认版本
];

// 临时缺口扫描（从 guide-index 分析）
function detectGaps() {
  const indexPath = join(KB_DIR, ".guide-index.json");
  if (!existsSync(indexPath)) {
    console.warn("[fill-gaps] 未找到 guide-index.json，跳过检测");
    return [];
  }

  const index = JSON.parse(readFileSync(indexPath, "utf-8"));
  const guides = Object.values(index.guideMap || {});
  const diseases = new Set(guides.map((g) => g.disease || g.key).filter(Boolean));

  const gaps = [];

  // 检查高优先级疾病
  const CHECK_DISEASES = [
    { disease: "肝硬化", version: "2025", current: [...diseases].filter((d) => d.includes("肝硬化")).join(",") },
    { disease: "2型糖尿病", version: "2025", current: [...diseases].filter((d) => d.includes("糖尿病")).join(",") },
    { disease: "神经", version: "2026", current: [...diseases].filter((d) => d.includes("神经") || d.includes("脑")).join(",") },
  ];

  for (const c of CHECK_DISEASES) {
    if (!c.current) {
      gaps.push({
        disease: c.disease,
        priority: c.disease === "肝硬化" ? 1 : 2,
        reason: `未收录任何"${c.disease}"相关指南`,
      });
    } else {
      console.log(`  ✓ ${c.disease} 已有收录: ${c.current.slice(0, 60)}`);
    }
  }

  return gaps;
}

// 从 PMC 获取全文（PMC OA）
async function fetchFromPMC(pmcId, title) {
  const urls = [
    // PMC OA 批量下载（XML + PDF 均可）
    `https://www.ncbi.nlm.nih.gov/pmc/articles/${pmcId}/pdf/`,
    // Europe PMC 全文 API
    `https://www.ebi.ac.uk/europepmc/api/search?query=${pmcId}&format=json&resultType=core&pageSize=1`,
  ];

  // 先抓 PDF（直接下载）
  console.log(`  [PMC] 尝试获取 ${title} (${pmcId})...`);

  try {
    const pdfUrl = urls[0];
    const res = await fetch(pdfUrl, { signal: AbortSignal.timeout(30000) });
    if (res.ok) {
      const buffer = await res.arrayBuffer();
      const outPath = join(RAW_DIR, `${pmcId}.pdf`);
      writeFileSync(outPath, Buffer.from(buffer));
      console.log(`  ✅ PDF 下载成功: ${outPath} (${buffer.byteLength} bytes)`);
      return { ok: true, path: outPath, format: "pdf" };
    }
  } catch (err) {
    console.log(`  ⏭ PDF 下载失败: ${err.message}，尝试 Europe PMC API...`);
  }

  // 兜底：Europe PMC API 获取结构化文本
  try {
    const apiUrl = urls[1];
    const res = await fetch(apiUrl, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const result = data?.resultList?.result?.[0];
      if (result?.fullTextUrlList?.fullTextUrl) {
        for (const link of result.fullTextUrlList.fullTextUrl) {
          if (link.documentStyle === "PDF" && link.availability === "Open access") {
            const pdfRes = await fetch(link.url, { signal: AbortSignal.timeout(30000) });
            if (pdfRes.ok) {
              const buffer = await pdfRes.arrayBuffer();
              const outPath = join(RAW_DIR, `${pmcId}.pdf`);
              writeFileSync(outPath, Buffer.from(buffer));
              console.log(`  ✅ PDF 下载成功 (via Europe PMC): ${outPath}`);
              return { ok: true, path: outPath, format: "pdf" };
            }
          }
        }
      }
    }
  } catch (err) {
    console.log(`  ⏭ Europe PMC API 失败: ${err.message}`);
  }

  return { ok: false, reason: "所有下载方式均失败" };
}

// 搜索 Europe PMC 找缺失指南
async function searchEuropePMC(keyword) {
  const url = `https://www.ebi.ac.uk/europepmc/api/search?query=(TITLE:"${encodeURIComponent(keyword)}") AND (SRC:MED) AND (FIRST_PDATE:[2024-01-01 TO 2026-12-31])&format=json&pageSize=5`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (res.ok) {
      const data = await res.json();
      const results = data?.resultList?.result || [];
      return results.map((r) => ({
        title: r.title,
        source: r.source,
        pmid: r.pmid,
        pmcid: r.pmcid,
        firstPublicationDate: r.firstPublicationDate,
        authorString: r.authorString,
      }));
    }
  } catch (err) {
    console.log(`  ⏭ 搜索失败: ${err.message}`);
  }
  return [];
}

async function main() {
  const args = process.argv.slice(2);
  const DETECT_ONLY = args.includes("--detect-only");
  const SOURCE = args.includes("--source")
    ? args[args.indexOf("--source") + 1]
    : "all";

  console.log("=".repeat(60));
  console.log("  KB 知识缺口补录工具");
  console.log("=".repeat(60));

  mkdirSync(RAW_DIR, { recursive: true });

  // Step 1: 检测缺口
  console.log("\n--- 1/3 检测知识缺口 ---");
  const detectedGaps = detectGaps();

  // 合并已知缺口 + 检测缺口
  const allGaps = [
    ...GAP_SOURCES.map((g) => ({ ...g, source: "known" })),
    ...detectedGaps.map((g) => ({ ...g, source: "detected" })),
  ];

  if (allGaps.length === 0) {
    console.log("\n✓ 未发现知识缺口");
    writeFileSync(GAP_FILE, JSON.stringify({ ts: new Date().toISOString(), gaps: [] }, null, 2));
    return;
  }

  console.log(`\n发现 ${allGaps.length} 个知识缺口（按优先级排序）:`);
  for (const g of allGaps.sort((a, b) => (a.priority || 9) - (b.priority || 9))) {
    console.log(`  [P${g.priority || 9}] ${g.title || g.disease} — ${g.reason}`);
  }

  // 写缺口报告
  writeFileSync(GAP_FILE, JSON.stringify({ ts: new Date().toISOString(), gaps: allGaps }, null, 2));
  console.log(`\n缺口报告已写入: ${GAP_FILE}`);

  if (DETECT_ONLY) {
    console.log("\n--detect-only 模式，不执行补录");
    return;
  }

  // Step 2: 尝试补录
  console.log("\n--- 2/3 执行补录 ---");
  const results = [];

  for (const gap of allGaps.sort((a, b) => (a.priority || 9) - (b.priority || 9))) {
    if (!gap.pmcId) {
      // 无已知 PMC ID 的缺口，先尝试搜索
      console.log(`\n[搜索] ${gap.disease}...`);
      const searchResults = await searchEuropePMC(gap.disease);
      if (searchResults.length > 0) {
        console.log(`  找到 ${searchResults.length} 条相关结果:`);
        for (const r of searchResults.slice(0, 3)) {
          console.log(`    - ${r.title} (${r.pmcid || "无 PMC ID"})`);
        }
        // 取第一条有 PMC ID 的结果下载
        const withPmc = searchResults.find((r) => r.pmcid);
        if (withPmc) {
          console.log(`  尝试下载: ${withPmc.title}`);
          const result = await fetchFromPMC(withPmc.pmcid, withPmc.title);
          results.push({ ...gap, ...result, fetchedTitle: withPmc.title });
          continue;
        }
      }
      console.log(`  ⏭ 未找到开放获取版本`);
      results.push({ ...gap, ok: false, reason: "未找到开放获取版本" });
      continue;
    }

    // 有已知 PMC ID
    const result = await fetchFromPMC(gap.pmcId, gap.title);
    results.push({ ...gap, ...result });
  }

  // Step 3: 汇总
  console.log("\n--- 3/3 补录汇总 ---");
  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);

  console.log(`  成功: ${succeeded.length}`);
  console.log(`  失败: ${failed.length}`);
  for (const s of succeeded) {
    console.log(`  ✅ ${s.title} → ${s.path}`);
  }
  for (const f of failed) {
    console.log(`  ❌ ${f.title || f.disease} — ${f.reason}`);
  }

  console.log("\n💡 补录得到的文件需执行以下步骤纳入索引:");
  console.log("   npm run kb:prepare    # PDF→TXT 转换");
  console.log("   npm run kb:outline    # 提取大纲");
  console.log("   npm run kb:index      # 构建索引");
  console.log("   npm run kb:rebuild    # 重建知识库");
}

main().catch((err) => {
  console.error("[fill-gaps] 执行失败:", err);
  process.exit(1);
});
