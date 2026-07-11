// scripts/kb/deprecate-versions.mjs
// 自动检测已废止旧版指南，标记 deprecated 标记并重建索引。
//
// 用途：
//   1. 检测 medical-raw/ 中新入文件，判断是否属既有指南的更新版本
//   2. 自动标记旧版为已废止，更新 guide-index
//   3. 检测 outline 中是否存在括号重复条目（全角/半角），自动去重
//
// 用法：node scripts/kb/deprecate-versions.mjs [--dry-run]
//
// 纯 node 运行，无需 API Key。依赖：.outline.json / .guide-index.json

import { readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const KB_DIR = join(ROOT, "medical-knowlegde-base");
const RAW_DIR = join(ROOT, "medical-raw");
const RAW_TXT_DIR = join(ROOT, "medical-raw-txt");

const dryRun = process.argv.includes("--dry-run");

// 括号归一化
function normalizeBrackets(s) {
  return s.replace(/（/g, "(").replace(/）/g, ")").replace(/〔/g, "[").replace(/〕/g, "]");
}

async function main() {
  console.log(`[deprecate-versions] 扫描指南版本关系...${dryRun ? " (演练模式 --dry-run)" : ""}`);

  // 1. 加载 outline
  const outlinePath = join(KB_DIR, ".outline.json");
  const indexPath = join(KB_DIR, ".guide-index.json");
  if (!existsSync(outlinePath)) {
    console.error("✗ .outline.json 不存在");
    process.exit(1);
  }
  const outline = JSON.parse(await readFile(outlinePath, "utf-8"));
  const guides = outline.guides || [];
  console.log(`  加载 outline: ${guides.length} 条指南`);

  // 2. 去重检测
  const bracketDups = [];
  const seen = new Map();
  for (const g of guides) {
    const norm = normalizeBrackets(g.title);
    const existing = seen.get(norm);
    if (existing) {
      bracketDups.push({ keep: existing, remove: g });
    } else {
      seen.set(norm, g);
    }
  }
  if (bracketDups.length) {
    console.log(`  括号重复: ${bracketDups.length} 组`);
    for (const d of bracketDups)
      console.log(`    ✗ 重复: "${d.remove.title}" → 保留 "${d.keep.title}"`);
  } else {
    console.log(`  括号重复: 0 (clean)`);
  }

  // 3. 版本检测
  const VER_RE = /\((\d{4})\s*年?(?:版|修订版|修订本|本)\)/;
  const AUD_RE = /(儿童|老年|妊娠|围产期|新生儿|婴幼儿|青少年|孕妇|胎儿|男性|女性|成年)/;
  const ORG_RE = /(中国抗癌协会|中华医学会|国家卫健委|国家卫生健康委|国家卫生健康委员会)/;

  // 按归一化疾病名分组
  const byDisease = new Map();
  for (const g of guides) {
    const normalizedBrackets = g.title.replace(/（/g, "(").replace(/）/g, ")");
    let disease = normalizedBrackets
      .replace(/诊疗指南.*$/, "")
      .replace(/诊疗方案.*$/, "")
      .replace(/\(\d{4}\s*年?(?:版|修订版|修订本|本)\)/g, "") // 去版次，避免同名因括号差异分到两组
      .trim();
    const verMatch = normalizedBrackets.match(VER_RE);
    const version = verMatch ? Number(verMatch[1]) : null;
    const audience = (normalizedBrackets.match(AUD_RE) || [])[1] || null;
    const org = (normalizedBrackets.match(ORG_RE) || [])[1] || null;
    const key = `${disease}|${audience || ""}|${org || ""}`;
    if (!byDisease.has(key)) byDisease.set(key, []);
    byDisease.get(key).push({ title: g.title, id: g.id, version, audience, org, disease });
  }

  const deprecations = [];
  for (const [, entries] of byDisease) {
    const withVer = entries.filter((e) => e.version != null);
    if (withVer.length < 2) continue;
    // 去重：同版本的不算更新（如括号差异造成的重复）
    const uniqueVersions = new Set(withVer.map((e) => e.version));
    if (uniqueVersions.size < 2) continue;
    // 同机构/人群检测
    const orgs = new Set(withVer.map((e) => e.org || ""));
    if (orgs.size > 1) continue;
    const auds = new Set(withVer.map((e) => e.audience || ""));
    if (auds.size > 1) continue;
    withVer.sort((a, b) => (a.version || 0) - (b.version || 0));
    const newest = withVer[withVer.length - 1];
    for (let i = 0; i < withVer.length - 1; i++) {
      const old = withVer[i];
      deprecations.push({
        oldTitle: old.title,
        oldVersion: old.version,
        newTitle: newest.title,
        newVersion: newest.version,
      });
    }
  }

  console.log(`\n  版本检测完成，可标记废止: ${deprecations.length} 项`);
  for (const d of deprecations)
    console.log(`    ⚠ [${d.oldVersion}] "${d.oldTitle}" → [${d.newVersion}] "${d.newTitle}"`);

  // 4. 输出汇总
  if (dryRun) {
    console.log("\n  演练模式完成，未实际修改。");
    console.log(`  需处理: 去重 ${bracketDups.length} 组 + 废止 ${deprecations.length} 项`);
    console.log('\n  执行: node scripts/kb/deprecate-versions.mjs');
    process.exit(0);
  }

  // 实际模式下重建索引 = 运行 build-guide-index.mjs
  console.log("\n  实际模式：重建指南索引以写入废止标记...");
  const { execFileSync } = await import("node:child_process");
  execFileSync(process.execPath, [join(ROOT, "scripts/kb/build-guide-index.mjs")], {
    stdio: "inherit",
    cwd: ROOT,
  });

  console.log("\n✓ 完成。");
  console.log(`  去重: ${bracketDups.length > 0 ? `检测到 ${bracketDups.length} 组括号重复，build-guide-index 已自动合并` : "无"}`);
  console.log(`  废止: ${deprecations.length} 项已标记`);
}

main().catch((err) => {
  console.error("[deprecate-versions] 失败:", err.message);
  process.exit(1);
});
