#!/usr/bin/env node
// ============================================================
// healthcheck.mjs — 医疗 Agentic RAG Web 服务健康检查
// 探测 WebUI HTTP 端点，输出 JSON 状态，并以退出码反映健康。
//   node scripts/ops/healthcheck.mjs [url]
//   WEBUI_URL=http://127.0.0.1:31415 node scripts/ops/healthcheck.mjs
// 退出码：0=健康，1=不健康
// 可供 docker-compose healthcheck 与监控脚本复用。
// ============================================================
import { existsSync, readFileSync } from "node:fs";
import { argv } from "node:process";

const url = argv[2] || process.env.WEBUI_URL || "http://127.0.0.1:31415";

// 启动时间（由 PID 文件推断，可选）
let since = null;
const pidFile = ".pi/webui.pid";
if (existsSync(pidFile)) {
  try {
    const pid = readFileSync(pidFile, "utf8").trim();
    since = { pid };
  } catch {
    /* ignore */
  }
}

async function main() {
  const started = Date.now();
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 5000);
    const res = await fetch(url, { signal: ctrl.signal, redirect: "manual" });
    clearTimeout(t);
    const ok = res.status >= 200 && res.status < 400;
    const out = {
      status: ok ? "up" : "degraded",
      url,
      httpStatus: res.status,
      latencyMs: Date.now() - started,
      since,
      ts: new Date().toISOString(),
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(ok ? 0 : 1);
  } catch (err) {
    const out = {
      status: "down",
      url,
      error: String(err && err.message ? err.message : err),
      latencyMs: Date.now() - started,
      since,
      ts: new Date().toISOString(),
    };
    console.log(JSON.stringify(out, null, 2));
    process.exit(1);
  }
}

main();
