// phi-crypto/audit.mjs
// 结构化审计日志

import { mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { alert } from "../alert-log.mjs";

const LOGS_DIR = join(process.cwd(), ".pi/logs");

export function auditLog(action, data = {}) {
  try {
    mkdirSync(LOGS_DIR, { recursive: true });
    const date = new Date().toISOString().slice(0, 10);
    const entry = JSON.stringify({ t: new Date().toISOString(), action, ...data }) + "\n";
    appendFileSync(join(LOGS_DIR, `audit-${date}.ndjson`), entry, "utf-8");
  } catch (err) {
    alert("phi-crypto", `审计写入失败: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function auditFileToday() {
  const date = new Date().toISOString().slice(0, 10);
  return join(LOGS_DIR, `audit-${date}.ndjson`);
}
