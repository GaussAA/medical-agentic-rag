#!/usr/bin/env bash
# ============================================================
# start-api.sh — 拉起「医疗 Agentic RAG」HTTP API 服务（T8 服务化）
#
# 机制：用 managed Node 22 运行 scripts/service/api-server.mjs。
#   api-server 会自行 spawn Pi RPC 会话（同样受控 Node22 + preload 劫持），
#   并自举 provider-proxy（LLM 网关）。无需手动起 proxy。
#
# 用法：
#   ./start-api.sh                              # 默认 127.0.0.1:8080 前台
#   API_PORT=9090 ./start-api.sh
#   API_TOKEN=xxxx ./start-api.sh               # 开启 Bearer 鉴权
#   ./start-api.sh -d                           # 后台守护（写 .pi/api.pid）
#   ./start-api.sh -d API_PORT=9090 API_TOKEN=xxxx
#
# 前置：.env 已配置 LLM API Key；已安装 pi + 扩展（KB 已构建）。
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Windows 原生路径
WIN_ROOT="$(pwd -W 2>/dev/null || pwd)"

# 固定 managed node 22（与 better-sqlite3 / Pi 子进程一致）
NODE_BIN="${NODE_BIN:-C:/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node.exe}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"

# 1) 加载 .env
if [ -f .env ]; then
  set -a
  . .env
  set +a
fi

# 服务期 KB 只读：关闭知识库 watcher 写锁，避免并发 spawn 的 Pi 子进程
# 因 WAL 写锁争用而静默 exit 1（压测发现的根因；KB 内容服务期静态不变）。
export PI_KNOWLEDGE_WATCH=false

# 2) 解析参数：-d 后台；KEY=VALUE 作为环境变量覆盖
BACKGROUND=0
for a in "$@"; do
  case "$a" in
    -d|--background) BACKGROUND=1 ;;
    *=*) export "${a%%=*}"="${a#*=}" ;;
  esac
done

# 3) 探测健康 Provider，写 .pi/failover-selection.json（api-server 自会读取）
echo "[api] 探测 Provider 健康态…"
"$NODE_BIN" scripts/proxy/launch-with-failover.mjs >/dev/null 2>&1 || true

# 4) 定位 api-server
API_BIN="$WIN_ROOT/scripts/service/api-server.mjs"
if [ ! -f "$API_BIN" ]; then
  echo "✗ 未找到 scripts/service/api-server.mjs" >&2
  exit 1
fi

PORT="${API_PORT:-8080}"
HOST="${API_HOST:-127.0.0.1}"

echo ""
echo "[Medical Agentic RAG · API]"
echo "  地址 : http://$HOST:$PORT/"
echo "  接口 : POST /api/v1/ask   POST /api/v1/model   GET /api/v1/models"
echo "  运维 : GET /healthz   GET /metrics   GET /api/v1/sessions"
echo "  工作区: $WIN_ROOT"
echo ""

mkdir -p .pi/logs

# 后台模式
if [ "$BACKGROUND" = "1" ] || [ "${API_BACKGROUND:-0}" = "1" ]; then
  MEDICAL_API_RUN=1 nohup "$NODE_BIN" "$API_BIN" > .pi/logs/api.log 2>&1 &
  echo $! > .pi/api.pid
  echo "[api] 后台启动 PID=$(cat .pi/api.pid) → http://$HOST:$PORT/"
  echo "[api] 日志: .pi/logs/api.log   停止: ./stop-api.sh"
  for i in $(seq 1 40); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
      echo "[api] 就绪 (${i}s)"; break
    fi
    sleep 1
  done
  exit 0
fi

NODE_ENV=production MEDICAL_API_RUN=1 exec "$NODE_BIN" "$API_BIN"
