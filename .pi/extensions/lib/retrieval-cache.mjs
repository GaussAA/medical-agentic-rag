// retrieval-cache.mjs
// 多层检索缓存：内存(L1) + 本地文件(L2) + Redis(L3) 三级架构。
//
// 设计要点：
// 1. 内存 Map 为热路径（同进程重复查询近乎零开销），文件为权威持久层。
// 2. Redis 为可选共享层（多 K8s Pod 共享），通过环境变量启用。
// 3. cacheGet：同步模式仅查内存+文件；cacheGetAsync：加查 Redis。
// 4. cacheSet：同步写内存+文件；异步 fire-and-forget 写 Redis。
// 5. TTL 过期自动失效；cacheStats / cacheClear 供 /cache 命令使用。
// 6. 原始 key 经哈希后落盘，敏感查询文本不写入缓存。
//
// 环境变量:
//   REDIS_URL                   — Redis 连接串（如 redis://localhost:6379），配置后自动启用
//   CACHE_BACKEND               — "auto"(默认,文件+可选Redis) | "redis"(强制Redis优先) | "file"(仅文件)
//   RETRIEVAL_CACHE_MAX_ENTRIES — 内存/文件条目上限（默认 500）
//   RETRIEVAL_CACHE_DIR         — 缓存文件目录（默认 .pi/cache）
//   RETRIEVAL_CACHE_TTL         — 缓存 TTL 秒数（默认 600=10分钟）
//
// 纯 JavaScript（.mjs），双可测。

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

const DEFAULT_TTL_MS = (parseInt(process.env.RETRIEVAL_CACHE_TTL || "600", 10)) * 1000; // 默认 10 分钟，env 可调秒数
const MAX_ENTRIES = parseInt(process.env.RETRIEVAL_CACHE_MAX_ENTRIES || "500", 10);
const CACHE_DIR = process.env.RETRIEVAL_CACHE_DIR || join(process.cwd(), ".pi", "cache");
const CACHE_FILE = join(CACHE_DIR, "retrieval-cache.json");

// ── Redis 后端 ──
const REDIS_URL = process.env.REDIS_URL || "";
const CACHE_BACKEND = (process.env.CACHE_BACKEND || "auto").toLowerCase();
const REDIS_ENABLED = REDIS_URL && (CACHE_BACKEND === "redis" || CACHE_BACKEND === "auto");
const REDIS_KEY_PREFIX = "rag:cache:";

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

// ── Redis 客户端（惰性初始化，与 conversation-state 同模式）──
let _redisClient = null;

async function getRedis() {
  if (_redisClient !== null) return _redisClient;
  if (!REDIS_ENABLED) { _redisClient = null; return null; }
  try {
    const { createClient } = await import("redis");
    const client = createClient({ url: REDIS_URL });
    client.on("error", () => { _redisClient = null; });
    await client.connect();
    _redisClient = client;
    return client;
  } catch {
    _redisClient = null;
    return null;
  }
}

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
 * 读取缓存（同步模式）。仅查内存 + 文件，不查 Redis。
 * 命中且未过期返回缓存值，否则返回 undefined。
 *
 * @param {string} key 原始键
 * @param {number} [ttlMs] 过期阈值，默认 DEFAULT_TTL_MS
 * @returns {any|undefined}
 */
export function cacheGet(key, ttlMs = DEFAULT_TTL_MS) {
  const h = cacheHash(key);
  const m = memory.get(h);
  if (fresh(m, ttlMs)) return m.value;
  if (m) memory.delete(h);
  const entries = readAll();
  const e = entries[h];
  if (fresh(e, ttlMs)) {
    memory.set(h, e);
    return e.value;
  }
  return undefined;
}

/**
 * 读取缓存（异步模式）。查内存 → Redis → 文件三级，返回最快可靠结果。
 * Redis 命中时回填内存，加速后续调用。
 *
 * @param {string} key 原始键
 * @param {number} [ttlMs] 过期阈值
 * @returns {Promise<any|undefined>}
 */
export async function cacheGetAsync(key, ttlMs = DEFAULT_TTL_MS) {
  const h = cacheHash(key);

  // 1. 内存（同步热路径）
  const m = memory.get(h);
  if (fresh(m, ttlMs)) return m.value;
  if (m) memory.delete(h);

  // 2. Redis（异步，多 Pod 共享层）
  if (REDIS_ENABLED) {
    try {
      const r = await getRedis();
      if (r) {
        const raw = await r.get(`${REDIS_KEY_PREFIX}${h}`);
        if (raw) {
          const e = JSON.parse(raw);
          if (fresh(e, ttlMs)) {
            memory.set(h, e);
            return e.value;
          }
        }
      }
    } catch {
      /* Redis 不可用 → 降级文件 */
    }
  }

  // 3. 文件（同步兜底）
  const entries = readAll();
  const e = entries[h];
  if (fresh(e, ttlMs)) {
    memory.set(h, e);
    return e.value;
  }
  return undefined;
}

/**
 * 写入缓存（同步写内存+文件，异步 fire-and-forget 写 Redis）。
 * 合并已有磁盘条目，避免多扩展实例互相覆盖。
 *
 * @param {string} key 原始键
 * @param {any} value 缓存值（须可 JSON 序列化）
 * @param {number} [ttlMs] 过期阈值，默认 DEFAULT_TTL_MS
 */
export function cacheSet(key, value, ttlMs = DEFAULT_TTL_MS) {
  const h = cacheHash(key);
  const entry = { value, ts: Date.now(), ttl: ttlMs };
  memory.set(h, entry);
  // 同步：文件写（read-modify-write + LRU 裁剪）
  mutateAll((entries) => {
    const now = Date.now();
    for (const k of Object.keys(entries)) {
      const e = entries[k];
      if (!e || now - e.ts >= (e.ttl || ttlMs)) delete entries[k];
    }
    entries[h] = entry;
    const keys = Object.keys(entries);
    if (keys.length > MAX_ENTRIES) {
      keys.sort((a, b) => entries[a].ts - entries[b].ts);
      for (const k of keys.slice(0, keys.length - MAX_ENTRIES)) delete entries[k];
    }
    return entries;
  });
  // 内存热缓存同步裁剪
  if (memory.size > MAX_ENTRIES) {
    const sorted = [...memory.entries()].sort((a, b) => a[1].ts - b[1].ts);
    for (const [k] of sorted.slice(0, memory.size - MAX_ENTRIES)) memory.delete(k);
  }
  // 异步：Redis 写（fire-and-forget，失败不影响主流程）
  if (REDIS_ENABLED) {
    _setRedisEntryAsync(h, entry, ttlMs);
  }
}

/** Redis 异步写 helper（fire-and-forget）。 */
function _setRedisEntryAsync(h, entry, ttlMs) {
  (async () => {
    try {
      const r = await getRedis();
      if (r) {
        await r.setEx(`${REDIS_KEY_PREFIX}${h}`, Math.ceil(ttlMs / 1000), JSON.stringify(entry));
      }
    } catch {
      /* Redis 写失败静默降级 */
    }
  })();
}

/** 缓存统计（有效/过期条目数 + 文件位置 + Redis 状态）。 */
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
    fileBackend: true,
    redisEnabled: REDIS_ENABLED,
    redisConnected: _redisClient !== null,
    backend: REDIS_ENABLED ? (CACHE_BACKEND === "redis" ? "redis_primary" : "auto") : "file",
  };
}

/** 清空缓存（内存 + 文件 + Redis）。 */
export function cacheClear() {
  memory.clear();
  mutateAll(() => ({}));
  if (REDIS_ENABLED) {
    (async () => {
      try {
        const r = await getRedis();
        if (r) {
          // 扫描所有 rag:cache: 开头的 key 并删除
          let cursor = "0";
          do {
            const scanResult = await r.scan(cursor, { match: `${REDIS_KEY_PREFIX}*`, count: 100 });
            cursor = scanResult.cursor;
            if (scanResult.keys.length > 0) await r.del(scanResult.keys);
          } while (cursor !== "0");
        }
      } catch {
        /* Redis 清理失败不阻断 */
      }
    })();
  }
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
