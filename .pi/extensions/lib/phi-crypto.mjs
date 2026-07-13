// phi-crypto.mjs
// PHI（个人健康信息）静态加密 + PII 脱敏 + 结构化审计 —— 医疗合规红线基础设施。
//
// 设计要点：
// 1. 加密：AES-256-GCM（认证加密，防篡改）。密钥优先取环境变量 PATIENT_DATA_KEY
//    （凭证零信任：不硬编码）；缺失则自动生成随机密钥落 .pi/.data-key（已 gitignore，chmod 600），
//    保证零配置也能密文落盘，而非退化为明文。
// 2. 脱敏：手机号、身份证、邮箱、结构化姓名 —— 供日志埋点在写盘前调用，
//    生产数据默认脱敏，原始 PHI 绝不进日志。
// 3. 审计：auditLog 追加到 logs/audit-YYYY-MM-DD.ndjson（与业务日志分离），
//    记录"谁在何时对 PHI 做了什么"，调用方须先脱敏。
// 4. 纯 JavaScript（.mjs）：既能被 Pi 的 jiti 加载（扩展内 import），
//    也能被原生 node 直接 import（单测 tests/unit/compliance-test.mjs）。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { alert } from "./alert-log.mjs";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  appendFileSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";

const ALGO = "aes-256-gcm";
const IV_LEN = 12; // GCM 推荐 96-bit IV
const TAG_LEN = 16; // GCM 认证标签
const KEY_LEN = 32; // AES-256
const PAYLOAD_PREFIX = "v1:gcm:"; // 版本前缀，便于未来平滑升级算法

const PI_DIR = join(process.cwd(), ".pi");
const KEY_FILE = join(PI_DIR, ".data-key");
const LOGS_DIR = join(process.cwd(), ".pi/logs");

/** 进程内密钥缓存，避免每次读盘。 */
let cachedKey = null;

/**
 * 解析 32 字节密钥：支持 hex(64 字符) 或 base64。长度不符则抛错。
 */
function parseKeyMaterial(raw) {
  const s = String(raw).trim();
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(s)) {
    buf = Buffer.from(s, "hex");
  } else {
    buf = Buffer.from(s, "base64");
  }
  if (buf.length !== KEY_LEN) {
    throw new Error(
      `PATIENT_DATA_KEY 长度非法：需 ${KEY_LEN} 字节（hex 64 位或 base64），实得 ${buf.length} 字节`,
    );
  }
  return buf;
}

/**
 * 获取加密密钥：
 *   ① 环境变量 PATIENT_DATA_KEY（凭证零信任，优先）
 *   ② 本地 .pi/.data-key（首次自动生成，gitignore + 权限 600）
 * @returns {Buffer} 32 字节密钥
 */
export function getKey() {
  if (cachedKey) return cachedKey;

  const envKey = process.env.PATIENT_DATA_KEY;
  if (envKey) {
    cachedKey = parseKeyMaterial(envKey);
    return cachedKey;
  }

  try {
    if (existsSync(KEY_FILE)) {
      cachedKey = parseKeyMaterial(readFileSync(KEY_FILE, "utf-8"));
      return cachedKey;
    }
  } catch (err) {
    // 密钥文件损坏时不静默：抛出让上层知晓，避免用错误密钥写出不可解密的数据
    throw new Error(
      `读取本地密钥 ${KEY_FILE} 失败：${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 首次运行：生成随机密钥并持久化
  const key = randomBytes(KEY_LEN);
  mkdirSync(PI_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key.toString("base64"), "utf-8");
  try {
    chmodSync(KEY_FILE, 0o600); // 仅属主可读写（Windows 上尽力而为）
  } catch {
    // Windows NTFS 无 POSIX 权限，chmod 可能无效，不阻断
  }
  cachedKey = key;
  return cachedKey;
}

/** 仅供测试：重置内存密钥缓存。 */
export function _resetKeyCache() {
  cachedKey = null;
}

/**
 * 加密字符串明文 → 自描述密文串（PAYLOAD_PREFIX + base64(iv|tag|cipher)）。
 * @param {string} plaintext
 * @returns {string} 密文串
 */
export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([
    cipher.update(String(plaintext), "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const payload = Buffer.concat([iv, tag, enc]).toString("base64");
  return PAYLOAD_PREFIX + payload;
}

/**
 * 解密密文串 → 明文。若非本模块密文（如旧明文），抛错由上层决定迁移策略。
 * @param {string} payload
 * @returns {string} 明文
 */
export function decrypt(payload) {
  if (typeof payload !== "string" || !payload.startsWith(PAYLOAD_PREFIX)) {
    throw new Error("非法密文：缺少版本前缀（可能是旧明文数据）");
  }
  const key = getKey();
  const raw = Buffer.from(payload.slice(PAYLOAD_PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
  return dec.toString("utf-8");
}

/** 判断字符串是否为本模块加密的密文。 */
export function isEncrypted(s) {
  return typeof s === "string" && s.startsWith(PAYLOAD_PREFIX);
}

/**
 * 加密 JSON 对象 → 密文串。
 */
export function encryptJSON(obj) {
  return encrypt(JSON.stringify(obj));
}

/**
 * 解密密文串 → JSON 对象。支持旧明文自动降级解析（迁移用）：
 *   - 若为密文，正常解密后 JSON.parse
 *   - 若为明文 JSON（无前缀），直接 parse 并返回，交由上层重写为密文
 * @param {string} payload
 * @returns {{ data: any, migrated: boolean }} data 为对象；migrated=true 表示读到旧明文需回写
 */
export function decryptJSON(payload) {
  if (isEncrypted(payload)) {
    return { data: JSON.parse(decrypt(payload)), migrated: false };
  }
  // 旧明文兼容：尝试直接 parse
  const data = JSON.parse(payload);
  return { data, migrated: true };
}

// ==================== PII 脱敏 ====================

/** 中国大陆手机号：保留前 3 后 4，中间 4 位掩码。 */
export function maskPhone(text) {
  return String(text).replace(
    /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g,
    "$1****$2",
  );
}

/** 身份证号（18 位，末位可为 X）：保留前 6 后 4，中间 8 位掩码。 */
export function maskIdCard(text) {
  return String(text).replace(
    /(?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)/g,
    "$1********$2",
  );
}

/** 邮箱：保留首字符与域名，用户名其余掩码。 */
export function maskEmail(text) {
  return String(text).replace(
    /([A-Za-z0-9])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g,
    "$1***$2",
  );
}

/**
 * 结构化姓名脱敏（用于已知是"姓名"的字段，而非自由文本）：
 *   张三 → 张*；欧阳娜娜 → 欧***。保留姓氏首字。
 */
export function maskName(name) {
  const s = String(name).trim();
  if (s.length <= 1) return s;
  return s[0] + "*".repeat(s.length - 1);
}

/**
 * 对自由文本做综合 PII 脱敏（手机号 + 身份证 + 邮箱）。
 * 姓名不在自由文本中做（中文姓名检测不可靠，易误伤），仅对结构化字段用 maskName。
 * @param {string} text
 * @returns {string}
 */
export function maskPII(text) {
  if (text == null) return text;
  let s = String(text);
  s = maskIdCard(s); // 先身份证（18 位）再手机号，避免手机号规则误吃身份证片段
  s = maskPhone(s);
  s = maskEmail(s);
  return s;
}

// ==================== 审计日志 ====================

/**
 * 追加一条结构化审计记录到 logs/audit-YYYY-MM-DD.ndjson。
 * 调用方须确保 data 已脱敏（本函数不代为脱敏敏感原文，仅兜底 stringify）。
 * @param {string} action 审计动作，如 "patient_profile.write" / "patient_profile.read"
 * @param {Record<string, unknown>} [data] 附加上下文（应为非敏感或已脱敏字段）
 */
export function auditLog(action, data = {}) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const entry =
      JSON.stringify({ t: new Date().toISOString(), action, ...data }) + "\n";
    appendFileSync(join(LOGS_DIR, `audit-${date}.ndjson`), entry, "utf-8");
  } catch (err) {
    // 审计失败不应吞掉：写 stderr，便于运维发现可观测性断裂
    alert(
      "phi-crypto",
      `写入失败: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** 审计文件路径（供 /audit 命令展示）。 */
export function auditFileToday() {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `audit-${date}.ndjson`);
}
