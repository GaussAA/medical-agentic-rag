// rotate-logs.mjs
// 日志轮转与磁盘清理 —— 防止 .pi/logs/ 及 temp 文件无限制膨胀。
//
// 策略:
//   ndjson 日志: 超过 7 天 → 压缩为 .gz → 超过 90 天 → 删除
//   会话归档:   超过 30 天 → 删除
//   临时文件:    超过 7 天 → 删除
//   快照文件:    保留最近 10 份
//
// 用法:
//   node scripts/ci/rotate-logs.mjs             默认模式（轮转+清理，输出摘要）
//   node scripts/ci/rotate-logs.mjs --dry-run   仅预览，不操作
//   node scripts/ci/rotate-logs.mjs --force     强制清理所有过期文件
//   node scripts/ci/rotate-logs.mjs --status    仅查看磁盘占用

import { existsSync, readdirSync, statSync, renameSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, extname } from "node:path";
import { gzipSync } from "node:zlib";

const ROOT = process.cwd();
const LOGS_DIR = join(ROOT, ".pi", "logs");
const SNAPSHOT_DIR = join(ROOT, ".pi", "kb-snapshots");
const ARCHIVE_DIR = join(ROOT, ".pi", "archive");
const RECYCLE_DIR = join(ROOT, ".pi", "recycle");
const CACHE_DIR = join(ROOT, ".pi", "cache");

const args = process.argv.slice(2);
const DRY_RUN = args.includes("--dry-run");
const FORCE = args.includes("--force");
const STATUS_ONLY = args.includes("--status");

// ── 工具函数 ──

function fmtBytes(n) {
  if (n > 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + " MB";
  if (n > 1024) return (n / 1024).toFixed(1) + " KB";
  return n + " B";
}

function dirSize(dir) {
  if (!existsSync(dir)) return 0;
  let total = 0;
  try {
    const files = readdirSync(dir, { recursive: true, encoding: "utf-8" });
    for (const f of files) {
      try {
        const fp = join(dir, f);
        if (statSync(fp).isFile()) total += statSync(fp).size;
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return total;
}

function ageDays(filePath) {
  try {
    const mtime = statSync(filePath).mtime;
    return (Date.now() - mtime.getTime()) / (24 * 60 * 60 * 1000);
  } catch { return 0; }
}

function gzipFile(src, dest) {
  try {
    const data = readFileSync(src);
    const compressed = gzipSync(data);
    writeFileSync(dest, compressed);
    return true;
  } catch {
    return false;
  }
}

// ── 扫描与清理 ──

function scanLogs() {
  if (!existsSync(LOGS_DIR)) return { files: [], totalSize: 0 };
  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.endsWith(".ndjson") || f.endsWith(".ndjson.gz"))
    .map((f) => {
      const fp = join(LOGS_DIR, f);
      return { name: f, path: fp, size: statSync(fp).size, age: ageDays(fp), isGz: f.endsWith(".gz") };
    });
  const totalSize = files.reduce((s, f) => s + f.size, 0);
  return { files, totalSize };
}

function rotateLogs() {
  const { files } = scanLogs();
  const rotated = [];
  let saved = 0;

  for (const f of files) {
    if (f.isGz) continue; // 已压缩的不再处理

    if (f.age > 90) {
      // 超过 90 天：删除
      if (!DRY_RUN) rmSync(f.path, { force: true });
      rotated.push({ name: f.name, action: "delete (>90d)", size: f.size });
      saved += f.size;
    } else if (f.age > 7) {
      // 超过 7 天：压缩
      const gzPath = f.path + ".gz";
      if (!DRY_RUN) {
        gzipFile(f.path, gzPath);
        rmSync(f.path, { force: true }); // 压缩后删原文件
      }
      const gzSize = existsSync(gzPath) ? statSync(gzPath).size : 0;
      const savedSize = f.size - gzSize;
      rotated.push({ name: f.name, action: `gzip (-> ${fmtBytes(gzSize)})`, size: f.size, saved: savedSize });
      saved += savedSize;
    }
  }

  return { rotated, saved };
}

function cleanArchive() {
  if (!existsSync(ARCHIVE_DIR)) return { deleted: 0, saved: 0 };
  let deleted = 0, saved = 0;
  const dirs = readdirSync(ARCHIVE_DIR, { recursive: false, encoding: "utf-8" }).filter((d) => {
    const fp = join(ARCHIVE_DIR, d);
    try { return statSync(fp).isDirectory(); } catch { return false; }
  });
  for (const d of dirs) {
    const fp = join(ARCHIVE_DIR, d);
    const a = ageDays(fp);
    if (a > 30) {
      if (!DRY_RUN) rmSync(fp, { recursive: true, force: true });
      deleted++;
      const sz = dirSize(fp);
      saved += sz;
    }
  }
  return { deleted, saved };
}

function cleanSnapshots() {
  if (!existsSync(SNAPSHOT_DIR)) return { kept: 0, deleted: 0, saved: 0 };
  const files = readdirSync(SNAPSHOT_DIR)
    .filter((f) => f.startsWith("kb-") && f.endsWith(".json"))
    .sort()
    .reverse();
  const KEEP = 10;
  let deleted = 0, saved = 0;
  for (let i = KEEP; i < files.length; i++) {
    const fp = join(SNAPSHOT_DIR, files[i]);
    if (!DRY_RUN) rmSync(fp, { force: true });
    deleted++;
    saved += statSync(fp).size;
  }
  return { kept: Math.min(files.length, KEEP), deleted, saved };
}

function diskStatus() {
  const logSize = dirSize(LOGS_DIR);
  const archiveSize = dirSize(ARCHIVE_DIR);
  const recycleSize = dirSize(RECYCLE_DIR);
  const cacheSize = dirSize(CACHE_DIR);
  const snapshotSize = dirSize(SNAPSHOT_DIR);

  console.log("━━━ 磁盘占用状态 ━━━\n");
  for (const [name, path, size] of [
    [".pi/logs/", LOGS_DIR, logSize],
    [".pi/archive/", ARCHIVE_DIR, archiveSize],
    [".pi/recycle/", RECYCLE_DIR, recycleSize],
    [".pi/cache/", CACHE_DIR, cacheSize],
    [".pi/kb-snapshots/", SNAPSHOT_DIR, snapshotSize],
  ]) {
    const bar = "▓".repeat(Math.max(1, Math.round((size / Math.max(1, logSize)) * 25)));
    console.log(`  ${name.padEnd(20)} ${fmtBytes(size).padStart(10)}  ${bar}`);
  }
  const total = logSize + archiveSize + recycleSize + cacheSize + snapshotSize;
  console.log(`  ${"─".repeat(34)}`);
  console.log(`  总计${"".padEnd(17)} ${fmtBytes(total).padStart(10)}`);
}

// ── 主流程 ──

function main() {
  if (STATUS_ONLY) {
    diskStatus();
    process.exit(0);
  }

  if (DRY_RUN) console.log("⚠ 预览模式（--dry-run），不会实际修改文件\n");

  // 1. 日志轮转
  console.log("1. 日志轮转 (.pi/logs/)");
  const logResult = rotateLogs();
  if (logResult.rotated.length === 0) {
    console.log("   无需要轮转的日志");
  } else {
    for (const r of logResult.rotated) {
      console.log(`   ${r.action.padEnd(25)} ${r.name} (${fmtBytes(r.size)})`);
    }
    console.log(`   释放空间: ${fmtBytes(logResult.saved)}`);
  }

  // 2. 会话归档清理
  console.log("\n2. 会话归档清理 (.pi/archive/)");
  const arcResult = cleanArchive();
  if (arcResult.deleted === 0) {
    console.log("   无需要清理的归档");
  } else {
    console.log(`   删除 ${arcResult.deleted} 个过期归档, 释放 ${fmtBytes(arcResult.saved)}`);
  }

  // 3. 快照保留
  console.log("\n3. 快照保留 (.pi/kb-snapshots/)");
  const snapResult = cleanSnapshots();
  if (snapResult.deleted === 0) {
    console.log(`   保留 ${snapResult.kept} 份快照`);
  } else {
    console.log(`   删除 ${snapResult.deleted} 份旧快照, 保留 ${snapResult.kept} 份, 释放 ${fmtBytes(snapResult.saved)}`);
  }

  // 摘要
  const totalSaved = (logResult.saved || 0) + (arcResult.saved || 0) + (snapResult.saved || 0);
  console.log(`\n━━━ 摘要 ━━━`);
  console.log(`  释放空间: ${fmtBytes(totalSaved)}`);
  if (!DRY_RUN) {
    const nowSize = dirSize(LOGS_DIR) + dirSize(ARCHIVE_DIR) + dirSize(CACHE_DIR) + dirSize(RECYCLE_DIR) + dirSize(SNAPSHOT_DIR);
    console.log(`  当前占用: ${fmtBytes(nowSize)}`);
  }
  console.log(`  模式: ${DRY_RUN ? "预览" : "执行"}`);
}

main();
