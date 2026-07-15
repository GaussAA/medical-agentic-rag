#!/usr/bin/env bash
# ============================================================
# docker-entrypoint-api.sh — 容器内拉起医疗 Agentic RAG HTTP API 服务（T8）
# 等价 start-api.sh 的容器版：先探测 Provider，再 exec api-server.mjs。
# api-server 会自行 spawn Pi RPC 会话 + 自举 provider-proxy。
# ============================================================
set -euo pipefail

APP=/app
cd "$APP"

# 1) .env（docker-compose 已通过 env_file 注入，此处兜底加载）
if [ -f .env ]; then
  set -a
  . .env
  set +a
fi

# 2) 探测健康 Provider，写 .pi/failover-selection.json（api-server 自会读取）
echo "[api] 探测 Provider 健康态…"
node scripts/proxy/launch-with-failover.mjs >/dev/null 2>&1 || true

PORT="${API_PORT:-8080}"
HOST="${API_HOST:-0.0.0.0}"

echo ""
echo "[Medical Agentic RAG · API]"
echo "  地址 : http://$HOST:$PORT/"
echo ""

exec node scripts/service/api-server.mjs
