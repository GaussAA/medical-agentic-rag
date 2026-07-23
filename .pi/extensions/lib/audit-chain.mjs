// audit-chain.mjs
// 防篡改审计哈希链 —— 审计日志不可否认基础设施。
//
// 核心机制：
//   1. 每审计条目前驱哈希链接（prevHash），形成哈希链
//   2. 每条 HMAC-SHA256 签名（密钥存 .pi/audit-key）
//   3. 验证器扫描全链，检测断裂/篡改
//
// 向后兼容：旧格式（无 prevHash/sig）条目自动跳过，不破坏验证

import { createHmac, createHash, randomBytes } from "node:crypto";
import { alert } from "./alert-log.mjs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  readdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

const PI_DIR = join(process.cwd(), ".pi");
const KEY_FILE = join(PI_DIR, ".audit-key");
const LOGS_DIR = join(process.cwd(), ".pi/logs");
const HMAC_ALGO = "sha256";

/** 进程内缓存密钥。 */
let cachedKey = null;

/**
 * 获取审计 HMAC 密钥：
 *   ① 环境变量 AUDIT_HMAC_KEY（优先）
 *   ② .pi/.audit-key（首次自动生成）
 */
function getKey() {
  if (cachedKey) return cachedKey;

  const envKey = process.env.AUDIT_HMAC_KEY;
  if (envKey) {
    cachedKey = Buffer.from(envKey, "hex");
    return cachedKey;
  }

  try {
    if (existsSync(KEY_FILE)) {
      cachedKey = readFileSync(KEY_FILE);
      return cachedKey;
    }
  } catch {
    // fall through
  }

  // 首次运行：生成 256-bit 随机密钥
  const key = randomBytes(32);
  mkdirSync(PI_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key.toString("hex"), "utf-8");
  try { chmodSync(KEY_FILE, 0o600); } catch { /* ignore */ }
  cachedKey = key;
  return cachedKey;
}

/**
 * 取前驱审计文件的最后一条哈希。
 * 按 day 文件读取，取非空最后一行，解析其 hash 字段。
 * @param {string} [date] ISO 日期 YYYY-MM-DD
 * @returns {string|null} 前驱 hash 值，无前驱返回 null
 */
function getPrevHash(date) {
  const file = join(LOGS_DIR, `audit-${date}.ndjson`);
  if (!existsSync(file)) return null;
  const content = readFileSync(file, "utf-8").trim();
  if (!content) return null;
  const lines = content.split("\n").filter((l) => l.trim());
  if (!lines.length) return null;
  try {
    const last = JSON.parse(lines[lines.length - 1]);
    return last.hash || null;
  } catch {
    return null;
  }
}

/**
 * 上一条审计的 hash（整个链的最后一条）。
 * 从当日及之前所有 day 文件扫描。
 */
function getLastChainHash() {
  const today = new Date().toISOString().slice(0, 10);
  // 优先当日
  const cur = getPrevHash(today);
  if (cur) return cur;

  // 倒序扫描历史文件
  try {
    const files = readdirSync(LOGS_DIR)
      .filter((f) => f.startsWith("audit-") && f.endsWith(".ndjson"))
      .sort()
      .reverse();
    for (const f of files) {
      const date = f.replace("audit-", "").replace(".ndjson", "");
      if (date >= today) continue; // 跳过今日（已查）
      const h = getPrevHash(date);
      if (h) return h;
    }
  } catch { /* ignore */ }
  return null;
}

/**
 * 计算 SHA-256 哈希。
 */
function sha256(data) {
  return createHash("sha256").update(data, "utf-8").digest("hex");
}

/**
 * 计算 HMAC-SHA256。
 */
function hmac(data) {
  return createHmac(HMAC_ALGO, getKey()).update(data, "utf-8").digest("hex");
}

/**
 * 写入防篡改审计条。
 * 格式（expand 兼容旧 ndjson）：
 *   {
 *     t: "ISO 时间戳",
 *     action: "审计动作",
 *     fields: [...],     // 仅字段名，不含原值
 *     prevHash: "...",   // 上一条的全链哈希
 *     hash: "...",       // SHA-256(prevHash + t + action + sorted_fields)
 *     sig: "..."         // HMAC-SHA256(hash)
 *   }
 *
 * @param {string} action 审计动作
 * @param {object} [data] 附加字段（应已脱敏）
 */
export function auditChainLog(action, data = {}) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const t = new Date().toISOString();

    // 构建规范化的条目内容（不含 hash/sig）
    const fields = { ...data };
    const content = { t, action, ...fields };

    // 前驱哈希
    const prevHash = getLastChainHash();

    // 规范字符串 = 排序键的 JSON
    const canonical = JSON.stringify(content, Object.keys(content).sort());

    // 本条目哈希 = SHA-256(prevHash || canonical)
    const hashInput = (prevHash || "") + canonical;
    const hash = sha256(hashInput);

    // HMAC 签名
    const sig = hmac(hash);

    // 组装最终条目
    const entry = JSON.stringify({
      ...content,
      prevHash,
      hash,
      sig,
    }) + "\n";

    const logFile = join(LOGS_DIR, `audit-${date}.ndjson`);
    appendFileSync(logFile, entry, "utf-8");
    return { hash, prevHash };
  } catch (err) {
    alert(
      "audit-chain",
      `写入失败: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/**
 * 验证单条审计条目的链完整性。
 *
 * @param {object} entry  解析后的审计条目对象
 * @param {string} prevHash 期望的前驱哈希（前一条的 hash 字段）
 * @returns {{ valid: boolean, reason?: string }}
 */
export function verifyEntry(entry, prevHash) {
  // 旧格式（无 prevHash/hash）跳过
  if (!entry.hash || !entry.prevHash === undefined) {
    return { valid: true, reason: "旧格式，无链验证" };
  }

  // 1. 前驱哈希匹配
  const expectedPrev = prevHash || null;
  const actualPrev = entry.prevHash || null;
  if (expectedPrev !== actualPrev) {
    return {
      valid: false,
      reason: `前驱哈希不匹配: 期望 ${expectedPrev}, 实际 ${actualPrev}`,
    };
  }

  // 2. 本条目哈希正确
  const { hash, sig, ...rest } = entry;
  const canonical = JSON.stringify(rest, Object.keys(rest).sort());
  const hashInput = (prevHash || "") + canonical;
  const expectedHash = sha256(hashInput);
  if (expectedHash !== entry.hash) {
    return {
      valid: false,
      reason: `哈希不匹配: 期望 ${expectedHash}, 实际 ${entry.hash}`,
    };
  }

  // 3. HMAC 签名验证
  const expectedSig = hmac(entry.hash);
  if (expectedSig !== entry.sig) {
    return {
      valid: false,
      reason: `签名不匹配: 期望 ${expectedSig}, 实际 ${entry.sig}`,
    };
  }

  return { valid: true };
}

/**
 * 验证整个审计链。
 *
 * @param {string} [date] 指定日期文件；不指定则检查全部
 * @returns {{ ok: boolean, total: number, valid: number, invalid: number, details: object[] }}
 */
export function verifyChain(date) {
  const dates = date
    ? [date]
    : readdirSync(LOGS_DIR)
        .filter((f) => f.startsWith("audit-") && f.endsWith(".ndjson"))
        .map((f) => f.replace("audit-", "").replace(".ndjson", ""))
        .sort();

  let total = 0;
  let valid = 0;
  let invalid = 0;
  let lastHash = null;
  const details = [];

  for (const d of dates) {
    const file = join(LOGS_DIR, `audit-${d}.ndjson`);
    if (!existsSync(file)) continue;

    const lines = readFileSync(file, "utf-8")
      .split("\n")
      .filter((l) => l.trim());

    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        total++;
        const result = verifyEntry(entry, lastHash);
        if (result.valid) {
          valid++;
        } else {
          invalid++;
          details.push({
            line: total,
            date: d,
            action: entry.action,
            t: entry.t,
            reason: result.reason,
          });
        }
        // 更新链尾哈希（即使旧格式也得下一跳）
        if (entry.hash) lastHash = entry.hash;
      } catch {
        total++;
        invalid++;
        details.push({ line: total, date: d, reason: "JSON 解析失败（可能被篡改）" });
      }
    }
  }

  return {
    ok: invalid === 0,
    total,
    valid,
    invalid,
    details,
    lastHash,
  };
}

/**
 * 查询审计日志（按条件过滤）。
 *
 * @param {object} [opts]
 * @param {string} [opts.action] 动作过滤（子串匹配）
 * @param {number} [opts.limit=50] 返回条数
 * @param {number} [opts.offset=0] 偏移
 * @returns {Array<object>}
 */
export function queryAuditLog(opts = {}) {
  const { action, limit = 50, offset = 0 } = opts;

  const files = readdirSync(LOGS_DIR)
    .filter((f) => f.startsWith("audit-") && f.endsWith(".ndjson"))
    .sort()
    .reverse();

  const results = [];
  for (const f of files) {
    const lines = readFileSync(join(LOGS_DIR, f), "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .reverse();
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (action && !entry.action?.includes(action)) continue;
        results.push(entry);
      } catch { /* skip malformed */ }
      if (results.length >= offset + limit) break;
    }
    if (results.length >= offset + limit) break;
  }

  return results.slice(offset, offset + limit);
}
