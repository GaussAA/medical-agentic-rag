#!/usr/bin/env bash
# ============================================================
# pi-proxy — 通过 Provider Proxy 启动 Pi，确保所有 LLM 调用
# 走 failover 链路（sensenova 免费优先，DeepSeek 付费兜底）
#
# 用法:
#   pi-proxy -p "你的问题"          # 非交互模式
#   pi-proxy                        # 交互式 TUI
#   pi-proxy --help                 # 查看 Pi 全部参数
#
# 环境变量:
#   PROXY_PORT   (默认 18880)
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

WIN_ROOT="$(pwd -W 2>/dev/null || pwd)"

# managed node 22
NODE_BIN=""
for cand in \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2/node" \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  "$(command -v node)"; do
  [ -n "$cand" ] && [ -x "$cand" ] && { NODE_BIN="$cand"; break; } || true
done
[ -z "$NODE_BIN" ] && NODE_BIN="node"

PROXY_PORT="${PROXY_PORT:-18880}"

# ── 检查 Provider Proxy 是否运行 ──
proxy_healthy() {
  curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1
}

# ── 如果 proxy 未运行，启动它 ──
if ! proxy_healthy; then
  echo "[pi-proxy] Provider Proxy 未运行，正在启动 (127.0.0.1:$PROXY_PORT)..."
  mkdir -p .pi/logs
  "$NODE_BIN" scripts/proxy/provider-proxy.mjs --port="$PROXY_PORT" >> ".pi/logs/proxy.log" 2>&1 &
  PROXY_PID=$!

  for i in $(seq 1 30); do
    if proxy_healthy; then
      echo "[pi-proxy]   → Provider Proxy 就绪 (PID $PROXY_PID)"
      break
    fi
    sleep 1
  done

  if ! proxy_healthy; then
    echo "[pi-proxy] ❌ Provider Proxy 启动失败，请检查 .pi/logs/proxy.log"
    exit 1
  fi
fi

# ── 读取 failover 选择 ──
PROVIDER="${LLM_PROVIDER:-sensenova}"
MODEL="${LLM_MODEL:-sensenova-6.7-flash-lite}"
if [ -f .pi/failover-selection.json ]; then
  FP=$(node -e "try{console.log(require('./.pi/failover-selection.json').provider||'')}catch(e){}" 2>/dev/null || true)
  FM=$(node -e "try{console.log(require('./.pi/failover-selection.json').model||'')}catch(e){}" 2>/dev/null || true)
  if [ -n "$FP" ] && [ -n "$FM" ]; then
    case "$FP" in
      sensenova|agnes|deepseek)
        PROVIDER="$FP"
        MODEL="$FM"
        ;;
    esac
  fi
fi

export NODE_PATH="$WIN_ROOT/pi/node_modules"
export PI_KNOWLEDGE_DIR="$WIN_ROOT/.pi/knowledge"

echo "[pi-proxy] LLM: $PROVIDER/$MODEL (via local proxy 127.0.0.1:$PROXY_PORT)"

# ── 通过 proxy 启动 Pi（非交互模式或者交互模式）──
exec "$NODE_BIN" \
  --require "$WIN_ROOT/scripts/proxy/preload-fetch-proxy.mjs" \
  "$WIN_ROOT/pi/packages/coding-agent/dist/cli.js" \
  --model "$PROVIDER/$MODEL" \
  --system-prompt "$WIN_ROOT/.pi/prompts/medical-agent.md" \
  --session-dir "$WIN_ROOT/.pi/sessions" \
  "$@"
