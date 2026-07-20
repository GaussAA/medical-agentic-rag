// phi-crypto/crypto.mjs
// AES-256-GCM 加密解密 + 密钥管理

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import {
  existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync,
  unlinkSync, statSync,
} from "node:fs";
import { join } from "node:path";
import { alert } from "../alert-log.mjs";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const PAYLOAD_PREFIX = "v1:gcm:";

const PI_DIR = join(process.cwd(), ".pi");
const KEY_FILE = join(PI_DIR, ".data-key");

let cachedKey = null;

function parseKeyMaterial(raw) {
  const s = String(raw).trim();
  let buf;
  if (/^[0-9a-fA-F]{64}$/.test(s)) buf = Buffer.from(s, "hex");
  else buf = Buffer.from(s, "base64");
  if (buf.length !== KEY_LEN) throw new Error(`密钥长度非法`);
  return buf;
}

export function getKey() {
  if (cachedKey) return cachedKey;
  const envKey = process.env.PATIENT_DATA_KEY;
  if (envKey) { cachedKey = parseKeyMaterial(envKey); return cachedKey; }
  try {
    if (existsSync(KEY_FILE)) { cachedKey = parseKeyMaterial(readFileSync(KEY_FILE, "utf-8")); return cachedKey; }
  } catch (err) { throw new Error(`读取密钥文件失败`); }
  const key = randomBytes(KEY_LEN);
  mkdirSync(PI_DIR, { recursive: true });
  writeFileSync(KEY_FILE, key.toString("base64"), "utf-8");
  try { chmodSync(KEY_FILE, 0o600); } catch { /* Windows */ }
  cachedKey = key;
  return cachedKey;
}

export function _resetKeyCache() { cachedKey = null; }

export function encrypt(plaintext) {
  const key = getKey();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(String(plaintext), "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PAYLOAD_PREFIX + Buffer.concat([iv, tag, enc]).toString("base64");
}

export function decrypt(payload) {
  if (typeof payload !== "string" || !payload.startsWith(PAYLOAD_PREFIX)) throw new Error("非法密文");
  const key = getKey();
  const raw = Buffer.from(payload.slice(PAYLOAD_PREFIX.length), "base64");
  const iv = raw.subarray(0, IV_LEN);
  const tag = raw.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const enc = raw.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf-8");
}

export function isEncrypted(s) { return typeof s === "string" && s.startsWith(PAYLOAD_PREFIX); }

export function encryptJSON(obj) { return encrypt(JSON.stringify(obj)); }

export function decryptJSON(payload) {
  if (isEncrypted(payload)) return { data: JSON.parse(decrypt(payload)), migrated: false };
  return { data: JSON.parse(payload), migrated: true };
}

export function secureWipeFile(filePath, passes = 3) {
  if (!existsSync(filePath)) return { wiped: true, reason: "absent" };
  try {
    const size = Math.max(statSync(filePath).size, 1);
    for (let i = 0; i < passes; i++) writeFileSync(filePath, randomBytes(size));
    unlinkSync(filePath);
    return { wiped: true };
  } catch (err) {
    return { wiped: false, reason: err instanceof Error ? err.message : String(err) };
  }
}
