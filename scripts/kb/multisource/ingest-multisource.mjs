// scripts/kb/multisource/ingest-multisource.mjs
//
// 通用多源摄取编排器（骨架核心）。
// 流程：缺口规格 → 适配器检索 → 四重质检闸门 → 取全文 → 中文渲染 →
//       落盘 medical-raw/ + medical-raw-txt/ → 登记 kb-sources.json →
//       终末四步重建（extract-outline → build-guide-index → rebuild-kb）。
//
// 设计要点：
//   - 仅摄取通过质检的开放许可内容；失败/不达标即跳过，绝不占位杜撰。
//   - 去重：名已登记或病种已覆盖则跳过。
//   - --dry-run 仅报告计划，不落盘、不重建。
//
// 用法：node scripts/kb/multisource/ingest-multisource.mjs [--dry-run] [--target cvd-ami]

import { writeFileSync, existsSync, readFileSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

import { evaluateCandidate } from "./quality-gate.mjs";
import { renderZhEntry } from "./lib/render-zh.mjs";
import * as epmc from "./adapters/papers-europepmc.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const RAW_DIR = join(ROOT, "medical-raw");
const TXT_DIR = join(ROOT, "medical-raw-txt");
const REG_FILE = join(ROOT, "kb-sources.json");
const KB_SOURCES = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const dryRun = process.argv.includes("--dry-run");
const targetArg = (() => {
  const i = process.argv.indexOf("--target");
  return i >= 0 ? process.argv[i + 1] : null;
})();

// ── 适配器注册表（接「四源并开」）──
const ADAPTERS = {
  europepmc: { mod: epmc, label: "学术论文(Europe PMC OA)" },
  // github / intl / other 适配器后续接入（见 adapters/ 下其余文件）
};

// ── 首批缺口规格（CVD 优先，直击此前会话暴露的急性心梗盲区）──
const GAP_TARGETS = [
  {
    id: "cvd-ami",
    disease: "急性心梗",
    query: "acute ST elevation myocardial infarction management guideline",
    keywords: ["急性心梗", "心肌梗死", "急性冠脉综合征", "STEMI", "再灌注治疗", "经皮冠状动脉介入治疗", "PCI", "抗凝", "溶栓"],
    enKeywords: ["myocardial", "infarction", "stemi", "acute coronary", "reperfusion", "st-segment", "pci", "anticoagul", "thromboly"],
    adapter: "europepmc",
    department: "心血管",
    maxDocs: 2,
  },
  {
    id: "cvd-hf",
    disease: "心力衰竭",
    query: "acute heart failure management guideline",
    keywords: ["心力衰竭", "心衰", "射血分数", "利尿剂", "ARNI", "β受体阻滞剂", "醛固酮拮抗剂"],
    enKeywords: ["heart failure", "ejection fraction", "diuretic", "arni", "beta blocker", "aldosterone"],
    adapter: "europepmc",
    department: "心血管",
    maxDocs: 2,
  },
];

function sanitizeName(s) {
  return String(s).replace(/[\\/:*?"<>|\s]+/g, "_").slice(0, 120);
}

async function main() {
  const targets = targetArg ? GAP_TARGETS.filter((t) => t.id === targetArg) : GAP_TARGETS;
  if (targets.length === 0) {
    console.error(`✗ 未找到目标 ${targetArg}`);
    process.exit(1);
  }
  console.log(`[multisource] 模式: ${dryRun ? "演练(dry-run)" : "实际摄取"} | 目标: ${targets.map((t) => t.id).join(", ")}`);

  const kb = await import(KB_SOURCES);
  const reg = kb.loadRegistry(REG_FILE);
  const existingIds = new Set(reg.sources.map((s) => s.id));
  const ingested = [];

  for (const gap of targets) {
    const ad = ADAPTERS[gap.adapter];
    if (!ad) { console.warn(`  ! 适配器 ${gap.adapter} 未注册，跳过 ${gap.id}`); continue; }
    console.log(`\n=== 目标 ${gap.id}（${gap.disease}）via ${ad.label} ===`);

    let candidates = [];
    try {
      candidates = await ad.mod.search({ query: gap.query, max: gap.maxDocs * 3 || 6, disease: gap.disease });
    } catch (e) {
      console.error(`  ✗ 检索失败: ${e.message}`);
      continue;
    }
    console.log(`  检索到 ${candidates.length} 条候选，过四重质检闸门…`);

    const passed = [];
    for (const c of candidates) {
      const verdict = evaluateCandidate(c, {
        disease: gap.disease,
        keywords: [...(gap.keywords || []), ...(gap.enKeywords || [])],
        minAuthority: 1,
      });
      const tag = verdict.pass ? `✓${verdict.score}` : `✗`;
      console.log(`    ${tag} ${c.title?.slice(0, 60)} | ${c.license || "?"}/${c.authority}/${c.year}`);
      if (verdict.pass) passed.push({ c, verdict });
    }
    // 强偏好 PMC 源（可经 JATS XML 取全文，绕开 NCBI 封锁）；非 PMC 源 fetch 多失败。
    // 用大乘子确保全部 PMC 候选恒优先于 MED 候选，再按质检分降序。
    passed.sort(
      (a, b) =>
        (b.c.source === "PMC" ? 10000 : 0) - (a.c.source === "PMC" ? 10000 : 0) ||
        b.verdict.score - a.verdict.score,
    );

    let taken = 0;
    for (const { c } of passed) {
      if (taken >= gap.maxDocs) break;
      const name = sanitizeName(`${gap.id}__${ad.mod.sourceName.replace(/\W+/g, "")}__${c.id}`);
      if (existingIds.has(name)) { console.log(`    · 已登记，跳过 ${name}`); continue; }
      console.log(`  [摄取] ${c.title?.slice(0, 60)} (${c.source}/${c.id})`);
      if (dryRun) { taken++; continue; }
      try {
        const enText = await ad.mod.fetchFull(c);
        if (!enText || enText.trim().length < 200) throw new Error("全文过短，疑似非指南内容");
        const sourceMeta = {
          name: ad.mod.sourceName,
          short: ad.mod.sourceName.replace(/[^A-Za-z0-9]/g, "").slice(0, 12) || "OA",
          license: c.license,
          url: c.url,
          year: c.year,
          openAccess: c.openAccess,
        };
        const finalText = renderZhEntry({ enText, gap, sourceMeta });
        const rawPath = join(RAW_DIR, `${name}.txt`);
        const txtPath = join(TXT_DIR, `${name}.txt`);
        writeFileSync(rawPath, finalText, "utf-8");
        writeFileSync(txtPath, finalText, "utf-8");
        // 登记 kb-sources.json
        reg.sources.push({
          id: name,
          name,
          type: "local",
          localPath: `medical-raw\\${name}.txt`,
          cadenceDays: 30,
          validate: "sha256",
          department: gap.department,
          lastChecked: new Date().toISOString(),
          lastHash: kb.contentHash(finalText),
          note: `多源摄取·${ad.label}·${c.license || "OA"}·${c.url}`,
        });
        existingIds.add(name);
        ingested.push({ name, disease: gap.disease, title: c.title });
        taken++;
        console.log(`    ✓ 已落盘 + 登记: ${name} (${finalText.length} 字符)`);
      } catch (e) {
        console.error(`    ✗ 摄取失败(跳过，不落半截): ${e.message}`);
      }
    }
  }

  if (dryRun) {
    console.log(`\n[dry-run] 计划摄取 ${ingested.length} 条（实际未落盘）。去掉 --dry-run 以执行。`);
    return;
  }

  if (ingested.length === 0) {
    console.log(`\n无新内容摄取，跳过重建。`);
    return;
  }

  // 回写登记表
  kb.saveRegistry(reg, REG_FILE);
  console.log(`\n✓ 已登记 ${ingested.length} 条至 kb-sources.json`);

  // 终末四步重建
  console.log(`\n=== 重建管线（extract-outline → build-guide-index → rebuild-kb）===`);
  for (const step of ["scripts/kb/extract-outline.mjs", "scripts/kb/build-guide-index.mjs"]) {
    console.log(`\n--- ${step} ---`);
    execFileSync(process.execPath, [join(ROOT, step)], { stdio: "inherit", cwd: ROOT });
  }
  console.log(`\n--- scripts/kb/rebuild-kb.mjs（增量）---`);
  execFileSync(process.execPath, [join(ROOT, "scripts/kb/rebuild-kb.mjs")], { stdio: "inherit", cwd: ROOT });

  console.log(`\n✓ 多源摄取完成。新入仓 ${ingested.length} 条：`);
  for (const d of ingested) console.log(`    + [${d.disease}] ${d.title?.slice(0, 50)}`);
}

main().catch((e) => {
  console.error("[multisource] 失败:", e.message);
  process.exit(1);
});
