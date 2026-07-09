// kb-sources.mjs
// 知识库来源登记与更新管理 —— 知识库扩展战役的核心纯函数库。
//
// 设计要点：
// 1. 来源登记表（kb-sources.json）：每项含 id/名称/类型(url或local)/地址/cadence/校验方式。
//    新增外部源只需登记一行，无需改代码——解决「无自动更新机制」根因。
// 2. 内容指纹（hash）：对来源内容求 sha256，hash 变化即视为有更新，触发重索引。
// 3. 版本快照 + 回滚：每次刷新前快照当前 registry 状态，刷新异常可回滚，保证可观测、可恢复。
// 4. staleness：距上次成功检查超 cadence 阈值即标记「过期待查」，供 /kb 命令与定时任务提醒。
// 5. 摄取（ingest）步骤留**可覆写钩子**：默认实现显式标记「未实现」，不假装完成——
//    外部源的真实抓取需凭证/网络，属手动提供认证数据的范畴（契合大帅爬虫规范）。
//
// 纯 JavaScript（.mjs）：既能被 Pi 的 jiti 加载（扩展内 import），
// 也能被原生 node 直接 import（scripts/kb-update.mjs 与单测）。

import { createHash } from "node:crypto";
import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";

const REGISTRY_FILE = join(process.cwd(), "kb-sources.json");
const SNAPSHOT_DIR = join(process.cwd(), ".pi", "kb-snapshots");

/** cadence（天）→ 毫秒阈值（容忍 1.5 倍漂移，避免网络抖动误报）。 */
function cadenceMs(cadenceDays) {
  return cadenceDays * 24 * 60 * 60 * 1000 * 1.5;
}

/**
 * 计算内容指纹（sha256 hex）。空内容返回固定哨兵，避免误判。
 */
export function contentHash(content) {
  if (content == null || content === "") return "EMPTY";
  return createHash("sha256").update(String(content), "utf-8").digest("hex");
}

/**
 * 读取来源登记表。文件不存在返回 { sources: [] }（不抛错，便于首次初始化）。
 */
export function loadRegistry(file = REGISTRY_FILE) {
  try {
    if (!existsSync(file))
      return { sources: [], meta: { lastFullCheck: null } };
    const data = JSON.parse(readFileSync(file, "utf-8"));
    return {
      sources: data.sources || [],
      meta: data.meta || { lastFullCheck: null },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`来源登记表解析失败: ${msg}`);
  }
}

/**
 * 写回来源登记表（原子写：tmp + rename）。
 */
export function saveRegistry(registry, file = REGISTRY_FILE) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(registry, null, 2), "utf-8");
  renameSync(tmp, file);
}

/**
 * 快照当前 registry 到 .pi/kb-snapshots/，返回快照路径。供回滚使用。
 */
export function snapshot(file = REGISTRY_FILE) {
  const registry = loadRegistry(file);
  mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = join(SNAPSHOT_DIR, `kb-${ts}.json`);
  writeFileSync(path, JSON.stringify(registry, null, 2), "utf-8");
  return path;
}

/**
 * 从快照回滚 registry（恢复文件内容）。返回快照路径。
 */
export function rollback(snapshotPath) {
  if (!existsSync(snapshotPath)) throw new Error(`快照不存在: ${snapshotPath}`);
  const data = readFileSync(snapshotPath, "utf-8");
  writeFileSync(REGISTRY_FILE, data, "utf-8");
  return snapshotPath;
}

/**
 * 列出所有快照文件（按时间倒序）。
 */
export function listSnapshots() {
  try {
    const files = readdirSync(SNAPSHOT_DIR)
      .filter((f) => f.startsWith("kb-") && f.endsWith(".json"))
      .sort()
      .reverse();
    return files.map((f) => join(SNAPSHOT_DIR, f));
  } catch {
    return [];
  }
}

/**
 * 判定单项来源是否过期（距上次成功检查超 cadence 阈值）。
 */
export function isStale(source, now = Date.now()) {
  if (!source.lastChecked) return true;
  const threshold = cadenceMs(source.cadenceDays || 30);
  return now - new Date(source.lastChecked).getTime() > threshold;
}

/**
 * 计算登记表中所有来源的过期情况。
 * @returns {{stale:object[],fresh:object[]}}
 */
export function checkStaleness(registry = loadRegistry()) {
  const stale = [];
  const fresh = [];
  for (const s of registry.sources) {
    (isStale(s) ? stale : fresh).push(s);
  }
  return { stale, fresh };
}

/**
 * 摄取钩子（可覆写）。默认显式标记「未实现」，不假装完成——
 * 真实外部源抓取需凭证/网络，由手动提供认证数据后覆写本函数或调用外部管线。
 * 返回 { ingested:false, reason, hash } 供调用方记录。
 */
export async function ingest(source, opts = {}) {
  if (opts.ingestOverride) {
    return opts.ingestOverride(source);
  }
  if (source.type === "local" && source.localPath) {
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      if (!existsSync(source.localPath)) {
        return {
          source: source.id,
          type: source.type,
          ingested: false,
          hash: "MISSING",
          error: true,
          reason: `本地文件缺失: ${source.localPath}`,
        };
      }
      const buf = readFileSync(source.localPath, "utf-8");
      return {
        source: source.id,
        type: source.type,
        ingested: true,
        hash: contentHash(buf),
        reason: `内容指纹已更新 (${buf.length} 字节)`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        source: source.id,
        type: source.type,
        ingested: false,
        hash: "ERROR",
        error: true,
        reason: `读取失败: ${msg}`,
      };
    }
  }
  return {
    source: source.id,
    type: source.type || "unknown",
    ingested: false,
    reason:
      "默认摄取未实现：外部源需凭证/网络，请手动提供认证数据后覆写 ingest 或调用外部管线",
    hash: contentHash(source.url || source.localPath || ""),
  };
}

/**
 * 刷新流程（可编排）：快照 → 逐项 ingest → 更新 lastChecked/hash → 回写。
 * 注意：默认 ingest 不实际抓取内容，故 hash 基于 source 元信息；真实内容抓取须由
 * ingestOverride 提供。异常时回滚至快照。
 * @returns {{ok:boolean, snapshot:string, results:object[], rolledBack:boolean}}
 */
export async function refreshAll(opts = {}) {
  const snap = snapshot();
  const registry = loadRegistry();
  const results = [];
  let failed = false;
  try {
    for (const s of registry.sources) {
      const r = await ingest(s, opts);
      results.push(r);
      if (r.error) {
        failed = true;
      } else {
        s.lastChecked = new Date().toISOString();
        s.lastHash = r.hash;
      }
    }
    registry.meta = registry.meta || {};
    registry.meta.lastFullCheck = new Date().toISOString();
    if (!failed) {
      saveRegistry(registry);
    } else {
      rollback(snap); // 任一项失败即回滚，保证 registry 不处于半更新态
    }
    return { ok: !failed, snapshot: snap, results, rolledBack: failed };
  } catch (err) {
    rollback(snap);
    return {
      ok: false,
      snapshot: snap,
      results,
      rolledBack: true,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
