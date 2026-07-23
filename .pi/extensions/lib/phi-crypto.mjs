// phi-crypto.mjs — 兼容入口（自动重导出拆分后的子模块）
//
// PHI（个人健康信息）静态加密 + PII 脱敏 + 结构化审计。
// 原单文件已按职责拆分为：
//   phi-crypto/crypto.mjs  — AES-256-GCM 加密/解密/密钥管理
//   phi-crypto/mask.mjs    — PII 脱敏（手机/身份证/邮箱）
//   phi-crypto/audit.mjs   — 审计日志
//
// 本文件保持所有导出接口不变，无需修改已有 import。

export { getKey, _resetKeyCache, encrypt, decrypt, isEncrypted, encryptJSON, decryptJSON, secureWipeFile } from "./phi-crypto/crypto.mjs";
export { maskPhone, maskIdCard, maskEmail, maskName, maskPII } from "./phi-crypto/mask.mjs";
export { auditLog, auditFileToday } from "./phi-crypto/audit.mjs";
