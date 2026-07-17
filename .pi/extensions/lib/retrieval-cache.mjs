// retrieval-cache.mjs
// 文件化（JSON）检索缓存 —— 供 guide_finder / kg_search / query-cache 共用同一存储。
//
// 设计要点：
// 1. 内存 Map 为热路径（同进程重复查询近乎零开销），文件为权威持久层（跨会话/跨扩展实例一致）。
// 2. cacheGet：先查内存，未命中再回退读盘；cacheSet：写内存 + 合并写盘（避免多实例互相覆盖）。
// 3. TTL 过期自动失效；cacheStats / cacheClear 供 /cache 命令使用。
// 4. 原始 key 经哈希后落盘，敏感查询文本不写入缓存文件。
//
// 纯 JavaScript（.mjs），无 TS 语法，故既能被 Pi 的 jiti 加载（扩展内 import），
// 也能被原生 node 直接 import（评测脚本 tests/unit/eval-bench.mjs）。

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

const DEFAULT_TTL_MS = 10 * 60 * 1000; // 10 分钟
const MAX_ENTRIES = parseInt(process.env.RETRIEVAL_CACHE_MAX_ENTRIES || "500", 10); // 条目容量上限（LRU 近似：超容按写入时间裁剪最旧）
const CACHE_DIR = process.env.RETRIEVAL_CACHE_DIR || join(process.cwd(), ".pi", "cache"); // 支持测试/自定义目录覆盖
const CACHE_FILE = join(CACHE_DIR, "retrieval-cache.json");

// ---------- 跨进程文件锁（防多实例并发 writeAll 互相覆盖） ----------
// 单进程下零开销（一次 wx 创建 + 一次 unlink）；多进程下保证 read-modify-write 原子性。
// 基于锁文件 + O_EXCL 原子创建（Windows 下 Node 用 CREATE_NEW 模拟），陈旧锁（持有者崩溃）自动释放。
const LOCK_FILE = `${CACHE_FILE}.lock`;
const LOCK_TIMEOUT_MS = 3000; // 最长等待 3s，超时降级为无锁尽力写（不阻断主流程）
const LOCK_STALE_MS = 10000; // 锁文件超过 10s 视为陈旧，强制释放
// 同步自旋用的极短休眠（Atomics.wait 在主线程阻塞但可控，最多 5ms/轮）
const _spin = new Int32Array(new SharedArrayBuffer(4));

function acquireLock() {
  const start = Date.now();
  while (Date.now() - start < LOCK_TIMEOUT_MS) {
    try {
      writeFileSync(LOCK_FILE, String(process.pid), { flag: "wx" }); // 不存在才创建，原子
      return true;
    } catch {
      // 已存在：检查是否陈旧（持有者可能崩溃未释放）
      try {
        const age = Date.now() - statSync(LOCK_FILE).mtimeMs;
        if (age > LOCK_STALE_MS) {
          try {
            unlinkSync(LOCK_FILE);
          } catch {
            /* 其他进程刚释放，下一轮重试 */
          }
          continue;
        }
      } catch {
        /* 锁文件消失，下一轮重试 */
      }
      try {
        Atomics.wait(_spin, 0, 0, 5); // 让出 5ms 再试
      } catch {
        /* SharedArrayBuffer 不可用时跳过等待（退化为忙等，极短） */
      }
    }
  }
  return false; // 超时：降级无锁写
}

function releaseLock() {
  try {
    unlinkSync(LOCK_FILE);
  } catch {
    /* 已释放或不存在，忽略 */
  }
}

/**
 * 在跨进程锁保护下执行 read-modify-write，保证多实例并发安全。
 * @param {(entries: object) => object} mutator 接收当前 entries，返回新 entries（或替换）
 * @returns {object} 最终落盘的 entries
 */
function mutateAll(mutator) {
  const locked = acquireLock();
  try {
    const entries = readAll();
    const next = mutator(entries) || entries;
    writeAllUnsafe(next);
    return next;
  } finally {
    if (locked) releaseLock();
  }
}

/** 进程内热缓存（同一加载实例内重复查询免读盘）。 */
const memory = new Map();

/**
 * 确定性字符串哈希（djb2 变体），用于把任意 query/参数压缩为短键。
 */
export function cacheHash(key) {
  let h = 5381;
  for (let i = 0; i < key.length; i++) {
    h = ((h << 5) + h + key.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

function readAll() {
  try {
    if (existsSync(CACHE_FILE)) {
      const data = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
      return data.entries || {};
    }
  } catch {
    // 损坏则视作空缓存
  }
  return {};
}

/**
 * 写入磁盘（不持锁 —— 调用方须保证已在锁内，或由 cacheClear/cacheSet 经 mutateAll 调用）。
 * @param {object} entries
 */
function writeAllUnsafe(entries) {
  try {
    mkdirSync(CACHE_DIR, { recursive: true });
    const tmp = `${CACHE_FILE}.tmp`;
    writeFileSync(tmp, JSON.stringify({ v: 1, entries }), "utf-8");
    renameSync(tmp, CACHE_FILE);
  } catch {
    // 尽力写，失败不影响主流程
  }
}

/** @deprecated 保留供向后兼容（单进程场景）；多进程请走 mutateAll。 */
function writeAll(entries) {
  writeAllUnsafe(entries);
}

function fresh(e, ttlMs) {
  return e && Date.now() - e.ts < (e.ttl || ttlMs);
}

/**
 * 读取缓存。命中且未过期返回缓存值，否则返回 undefined。
 * @param {string} key 原始键（如归一化后的 query 或序列化参数）
 * @param {number} [ttlMs] 过期阈值，默认 DEFAULT_TTL_MS
 */
export function cacheGet(key, ttlMs = DEFAULT_TTL_MS) {
  const h = cacheHash(key);
  const m = memory.get(h);
  if (fresh(m, ttlMs)) return m.value;
  if (m) memory.delete(h); // 内存命中但已过期：丢弃，避免陈旧值滞留热路径
  const entries = readAll();
  const e = entries[h];
  if (fresh(e, ttlMs)) {
    memory.set(h, e); // 回填内存，加速后续命中
    return e.value;
  }
  // 磁盘命中但已过期：仅清内存标记，磁盘过期项由 cacheSet/gcExpired 统一回收（读路径不写盘）
  return undefined;
}

/**
 * 写入缓存。合并已有磁盘条目，避免多扩展实例互相覆盖。
 * @param {string} key 原始键
 * @param {any} value 缓存值（须可 JSON 序列化）
 * @param {number} [ttlMs] 过期阈值，默认 DEFAULT_TTL_MS
 */
export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  const h = cacheHash(key);
  const entry = { value, ts: Date.now(), ttl: ttlMs };
  memory.set(h, entry);
  // read-modify-write 整体在锁内，杜绝多进程并发丢更新；
  // 顺带回收过期条目 + 超容按写入时间 LRU 近似裁剪，抑制缓存文件/内存单调膨胀。
  mutateAll((entries) => {
    const now = Date.now();
    for (const k of Object.keys(entries)) {
      const e = entries[k];
      if (!e || now - e.ts >= (e.ttl || ttlMs)) delete entries[k]; // 回收过期
    }
    entries[h] = entry;
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      // 按写入时间升序，裁掉最旧 (keys.length - MAX_ENTRIES) 个
      keys.sort((a, b) => entries[a].ts - entries[b].ts);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
    }
    return entries;
  });
  // 内存热缓存同步裁剪，避免与磁盘容量漂移
  if (memory.size > MAX_ENTRIES) {
    const sorted = [...memory.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of sorted.slice(0, memory.size - MAX_ENTRIES)) memory.delete(k);
  }
}

/** 缓存统计（有效/过期条目数 + 文件位置）。 */
export function cacheStats() {
  const entries = readAll();
  const now = Date.now();
  let valid = 0;
  let expired = 0;
  for (const e of Object.values(entries)) {
    if (now - e.ts < (e.ttl || DEFAULT_TTL_MS)) valid++;
    else expired++;
  }
  return {
    total: Object.keys(entries).length,
    valid,
    expired,
    file: CACHE_FILE,
  };
}

/** 清空缓存（内存 + 磁盘）。 */
export function cacheClear() {
  memory.clear();
  mutateAll(() => ({}));
}

/**
 * 主动回收所有过期条目（内存 + 磁盘），返回清理条数。
 * 供 /cache gc 命令或定时任务调用，抑制纯读场景下过期条目长期占盘。
 */
export function gcExpired() {
  const now = Date.now();
  for (const [k, e] of memory.entries()) {
    if (!e || now - e.ts >= (e.ttl || DEFAULT_TTL_MS)) memory.delete(k);
  }
  let removed = 0;
  mutateAll((entries) => {
    for (const k of Object.keys(entries)) {
      const e = entries[k];
      if (!e || now - e.ts >= (e.ttl || DEFAULT_TTL_MS)) {
        delete entries[k];
        removed++;
      }
    }
    return entries;
  });
  return removed;
}
