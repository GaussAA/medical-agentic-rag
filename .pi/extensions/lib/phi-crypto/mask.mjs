// phi-crypto/mask.mjs
// PII 脱敏函数（手机号/身份证/邮箱/姓名）

export function maskPhone(text) {
  return String(text).replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, "$1****$2");
}

export function maskIdCard(text) {
  return String(text).replace(/(?<!\d)(\d{6})\d{8}(\d{3}[\dXx])(?!\d)/g, "$1********$2");
}

export function maskEmail(text) {
  return String(text).replace(/([A-Za-z0-9])[A-Za-z0-9._%+-]*(@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g, "$1***$2");
}

export function maskName(name) {
  const s = String(name).trim();
  if (s.length <= 1) return s;
  return s[0] + "*".repeat(s.length - 1);
}

export function maskPII(text) {
  if (text == null) return text;
  let s = String(text);
  s = maskIdCard(s);
  s = maskPhone(s);
  s = maskEmail(s);
  return s;
}
