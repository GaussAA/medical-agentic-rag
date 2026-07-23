// kb-recycle.mjs
// 知识库回收站 —— 安全删除 + 回滚恢复。
//
// 设计要点：
// 1. 删除非销毁——从 kb-sources.json 移除登记 + 源文件移入 _discarded/，
//    同时留存完整原始 registry 条目于回收站清单。
// 2. 30 天自动过期清理（purgeExpired），期内可随时恢复（restoreFromRecycle）。
// 3. 恢复时逆向操作：registry 写回 + 文件从 _discarded/ 移回 raw/。
// 4. 回收站清单是单文件原子写（tmp+rename），与 kb-sources.json 同规范。
//
// 纯 JavaScript（.mjs）：既能被 Pi 的 jiti 加载，也能被原生 node 直接 import。

import { existsSync, writeFileSync, renameSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname, basename, extname } from "node:path";
import { randomUUID } from "node:crypto";

// ------ 路径常量 ------

const ROOT = process.cwd();
const REGISTRY_FILE = join(ROOT, "data", "kb", "kb-sources.json");
const RECYCLE_DIR = join(ROOT, ".pi", "recycle");
const RECYCLE_MANIFEST = join(RECYCLE_DIR, "kb-recycle.json");
const RAW_DIR = join(ROOT, "data", "raw");
const RAW_TXT_DIR = join(ROOT, "data", "raw-txt");
const KB_DIR = join(ROOT, "data", "kb");

/** 回收站保留期限（毫秒）。默认 30 天。 */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

// ------ 内部工具 ------

function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
}

/**
 * 原子写 JSON（tmp + rename）。
 */
function atomicWrite(file, data) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf-8");
  renameSync(tmp, file);
}

/**
 * 读 JSON 文件，不存在或损坏时返回默认值。
 */
function readJSON(file, fallback) {
  try {
    if (!existsSync(file)) return fallback;
    return JSON.parse(readFileSync(file, "utf-8"));
  } catch {
    return fallback;
  }
}

// ------ 回收站清单操作 ------

/**
 * 读取回收站清单。
 * @returns {{ entries: Array<RecycleEntry> }}
 */
export function loadRecycle() {
  return readJSON(RECYCLE_MANIFEST, { entries: [] });
}

/**
 * 写入回收站清单（原子写）。
 */
function saveRecycle(data) {
  ensureDir(RECYCLE_DIR);
  atomicWrite(RECYCLE_MANIFEST, data);
}

// ------ 核心公开函数 ------

/**
 * 将指定 sourceId 移入回收站。
 *
 * 流程：
 *   1. 从 registry 中读取该 source 的完整条目
 *   2. 将其原始文件移入 `data/raw/_discarded/{sourceId}/`
 *   3. 从 registry 移除该条目
 *   4. 写入回收站清单
 *
 * @param {string} sourceId  来源 ID（kb-sources.json 中的 id 字段）
 * @param {object} [opts]    可选参数
 * @param {string} [opts.reason]  删除原因（可选）
 * @returns {{ ok: boolean, entry: object|null, error?: string }}
 */
export function removeFromRegistry(sourceId, opts = {}) {
  const registry = readJSON(REGISTRY_FILE, { sources: [] });
  const idx = registry.sources.findIndex((s) => s.id === sourceId);
  if (idx === -1) {
    return { ok: false, entry: null, error: `来源未找到: "${sourceId}"` };
  }

  const original = registry.sources[idx];

  // 1. 从 registry 移除
  registry.sources.splice(idx, 1);
  atomicWrite(REGISTRY_FILE, registry);

  // 2. 移动原始文件到 _discarded/{sourceId}/
  const movedFiles = [];
  if (original.localPath) {
    const rawPath = join(RAW_DIR, basename(original.localPath));
    if (existsSync(rawPath)) {
      const discardDir = join(RAW_DIR, "_discarded", sourceId);
      ensureDir(discardDir);
      const dest = join(discardDir, basename(rawPath));
      renameSync(rawPath, dest);
      movedFiles.push({ from: rawPath, to: dest, type: "raw" });
    }
  }

  // 同一 source 可能在 raw-txt 有同名 .txt 文件
  const txtName = sourceId + ".txt";
  const txtPath = join(RAW_TXT_DIR, txtName);
  if (existsSync(txtPath)) {
    const discardDir = join(RAW_DIR, "_discarded", sourceId);
    ensureDir(discardDir);
    const dest = join(discardDir, txtName);
    renameSync(txtPath, dest);
    movedFiles.push({ from: txtPath, to: dest, type: "raw-txt" });
  }

  // 同一 source 可能在 data/kb 有 .md 索引文件
  const mdName = sourceId + ".md";
  const mdPath = join(KB_DIR, mdName);
  if (existsSync(mdPath)) {
    const discardDir = join(RAW_DIR, "_discarded", sourceId);
    ensureDir(discardDir);
    const dest = join(discardDir, mdName);
    renameSync(mdPath, dest);
    movedFiles.push({ from: mdPath, to: dest, type: "kb-md" });
  }

  // 3. 写入回收站清单
  const recycle = loadRecycle();
  const entry = {
    id: randomUUID(),
    sourceId: original.id,
    sourceName: original.name,
    removedAt: new Date().toISOString(),
    removedBy: opts.removedBy || "cli",
    reason: opts.reason || "",
    originalEntry: { ...original },
    movedFiles,
    restoredAt: null,
  };
  recycle.entries.push(entry);
  saveRecycle(recycle);

  return { ok: true, entry };
}

/**
 * 从回收站恢复指定条目。
 *
 * @param {string} recycleId  回收站条目的 id（UUID）
 * @returns {{ ok: boolean, entry: object|null, error?: string }}
 */
export function restoreFromRecycle(recycleId) {
  const recycle = loadRecycle();
  const idx = recycle.entries.findIndex((e) => e.id === recycleId);
  if (idx === -1) {
    return { ok: false, entry: null, error: `回收站条目未找到: "${recycleId}"` };
  }

  const entry = recycle.entries[idx];

  // 1. 恢复原始文件
  for (const f of entry.movedFiles || []) {
    if (existsSync(f.to)) {
      const destDir = dirname(f.from);
      ensureDir(destDir);
      renameSync(f.to, f.from);
    }
  }

  // 2. 恢复 registry 条目
  const registry = readJSON(REGISTRY_FILE, { sources: [] });
  const existing = registry.sources.find((s) => s.id === entry.sourceId);
  if (existing) {
    // 如果同 id 已存在（罕见：其他操作补回了同名源），覆盖
    Object.assign(existing, entry.originalEntry);
  } else {
    registry.sources.push({ ...entry.originalEntry });
  }
  atomicWrite(REGISTRY_FILE, registry);

  // 3. 标记为已恢复并从回收站移除
  recycle.entries.splice(idx, 1);
  saveRecycle(recycle);

  return { ok: true, entry: { ...entry, restoredAt: new Date().toISOString() } };
}

/**
 * 列出回收站内容。
 * @param {object} [opts]
 * @param {boolean} [opts.includeExpired]  是否包含已过期条目（默认 false）
 * @returns {Array}
 */
export function listRecycle(opts = {}) {
  const recycle = loadRecycle();
  let entries = recycle.entries;
  if (!opts.includeExpired) {
    const now = Date.now();
    entries = entries.filter((e) => {
      const age = now - new Date(e.removedAt).getTime();
      return age < RETENTION_MS;
    });
  }
  // 按删除时间倒序
  return entries.sort((a, b) => new Date(b.removedAt).getTime() - new Date(a.removedAt).getTime());
}

/**
 * 获取回收站统计信息。
 * @returns {{ total: number, expiredCount: number, oldestRemoved: string|null }}
 */
export function getRecycleStats() {
  const recycle = loadRecycle();
  const now = Date.now();
  let expiredCount = 0;
  let oldest = null;
  for (const e of recycle.entries) {
    const age = now - new Date(e.removedAt).getTime();
    if (age >= RETENTION_MS) expiredCount++;
    if (!oldest || e.removedAt < oldest) oldest = e.removedAt;
  }
  return {
    total: recycle.entries.length,
    expiredCount,
    oldestRemoved: oldest,
    retentionDays: RETENTION_MS / (24 * 60 * 60 * 1000),
  };
}

/**
 * 清理已过期的回收站条目（超 30 天）。
 * 过期条目的关联文件从 _discarded/ 中删除，防止磁盘泄漏。
 * @returns {{ purged: number, errors: string[] }}
 */
export function purgeExpired() {
  const recycle = loadRecycle();
  const now = Date.now();
  const kept = [];
  const purged = [];
  const errors = [];

  for (const entry of recycle.entries) {
    const age = now - new Date(entry.removedAt).getTime();
    if (age < RETENTION_MS) {
      kept.push(entry);
      continue;
    }
    // 过期：删除整个废弃目录（递归）
    const discardDir = join(RAW_DIR, "_discarded", entry.sourceId);
    try {
      if (existsSync(discardDir)) rmSync(discardDir, { recursive: true, force: true });
    } catch (err) {
      errors.push(`清理失败 [${entry.sourceId}] 目录 ${discardDir}: ${err instanceof Error ? err.message : err}`);
    }
    purged.push(entry.id);
  }

  recycle.entries = kept;
  saveRecycle(recycle);

  return { purged: purged.length, errors };
}

/**
 * 清空回收站（全部物理删除，不可恢复）。
 * @returns {{ purged: number, errors: string[] }}
 */
export function emptyRecycle() {
  const recycle = loadRecycle();
  const errors = [];
  const count = recycle.entries.length;

  for (const entry of recycle.entries) {
    // 删除整个废弃目录
    const discardDir = join(RAW_DIR, "_discarded", entry.sourceId);
    try {
      if (existsSync(discardDir)) rmSync(discardDir, { recursive: true, force: true });
    } catch (err) {
      errors.push(`删除失败 [${entry.sourceId}] ${discardDir}: ${err instanceof Error ? err.message : err}`);
    }
  }

  saveRecycle({ entries: [] });
  return { purged: count, errors };
}
