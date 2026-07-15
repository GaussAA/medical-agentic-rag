#!/usr/bin/env node
// ============================================================
// metrics-exporter.mjs — 医疗 Agentic RAG 轻量指标导出（Prometheus 格式）
//
// 扫描审计日志 logs/audit-*.ndjson，在 :19100 暴露 /metrics。
// 采集/渲染逻辑已抽到 scripts/ops/metrics-format.mjs（与 API 服务共用）。
//
// 用法：
//   node scripts/ops/metrics-exporter.mjs            # 默认 :19100
//   METRICS_PORT=19100 node scripts/ops/metrics-exporter.mjs
// 容器/docker-compose 已暴露该端口供 Prometheus 抓取。
// ============================================================
import { createServer } from "node:http";
import { join } from "node:path";
import { renderMedicalRagMetrics } from "./metrics-format.mjs";

const PORT = Number(process.env.METRICS_PORT || 19100);
const HOST = process.env.METRICS_HOST || "0.0.0.0";
// 审计日志位于项目 cwd 下的 .pi/logs/audit-YYYY-MM-DD.ndjson
const LOG_DIR = process.env.AUDIT_LOG_DIR || join(process.cwd(), ".pi", "logs");
const STARTED = Date.now();

const server = createServer((req, res) => {
  if (req.url === "/metrics") {
    res.writeHead(200, { "Content-Type": "text/plain; version=0.0.4" });
    res.end(renderMedicalRagMetrics(LOG_DIR, STARTED));
  } else if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ status: "up" }));
  } else {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("medical-rag metrics exporter\n/metrics  /healthz\n");
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[metrics] Prometheus /metrics on http://${HOST}:${PORT}/`);
});
