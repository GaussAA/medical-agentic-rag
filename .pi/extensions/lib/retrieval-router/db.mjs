// retrieval-router/db.mjs — better-sqlite3 加载 + 连接管理

import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function loadBetterSqlite3() {
  const candidates = [
    "better-sqlite3",
    process.env.PI_AGENT_NPM && join(process.env.PI_AGENT_NPM, "node_modules", "better-sqlite3"),
    "C:/Users/JaNiy/.pi/agent/npm/node_modules/better-sqlite3",
    join(process.env.USERPROFILE || process.env.HOME || "", ".pi", "agent", "npm", "node_modules", "better-sqlite3"),
  ].filter(Boolean);
  let lastErr;
  for (const c of candidates) { try { const mod = require(c); if (mod) return mod.default || mod; } catch (e) { lastErr = e; } }
  throw new Error("better-sqlite3 不可用：" + (lastErr?.message || ""));
}

export const Database = loadBetterSqlite3();

export function resolveKbDbPath() {
  const env = process.env.PI_KNOWLEDGE_DIR || process.env.PICODING_KNOWLEDGE_DIR;
  if (env) return join(env, "knowledge.db");
  const home = process.env.USERPROFILE || process.env.HOME || "";
  if (home) return join(home, ".pi", "knowledge", "knowledge.db");
  return null;
}

let _db = null;
let _dbPathOverride = null;

export function setKbDb(dbOrPath) {
  if (dbOrPath == null) { _db = null; _dbPathOverride = null; return; }
  if (typeof dbOrPath === "string") { _dbPathOverride = dbOrPath; _db = null; }
  else { _db = dbOrPath; _dbPathOverride = null; }
}

export function getDb() {
  if (_db) return _db;
  const p = _dbPathOverride || resolveKbDbPath();
  if (!p || !existsSync(p)) return null;
  _db = new Database(p, { readonly: true, fileMustExist: true });
  return _db;
}

export function safeJson(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
