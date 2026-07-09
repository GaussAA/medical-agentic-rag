#!/usr/bin/env bash
# ============================================================
# start.sh — Medical Agentic RAG 启动脚本（Git Bash 专用）
# 优先免费模型（sensenova-6.7-flash-lite），失败回退 deepseek
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# 1) 加载 .env
if [ -f .env ]; then
  set -a
  . .env
  set +a
fi

# 2) 探测健康 Provider，写 failover-selection.json
echo "[orchestration] 探测健康 Provider..."
node scripts/launch-with-failover.mjs 2>/dev/null || true

# 3) 读 failover 结果
SEL_FILE="$ROOT/.pi/failover-selection.json"
if [ -f "$SEL_FILE" ]; then
  PROVIDER=$(node -e "const j=require('$SEL_FILE');console.log(j.selected||'')")
  MODEL=$(node -e "const j=require('$SEL_FILE');console.log(j.model||'')")
else
  PROVIDER="${LLM_PROVIDER:-deepseek}"
  MODEL="${LLM_MODEL:-deepseek-v4-flash}"
fi
echo "[orchestration]   → 选定 Provider: $PROVIDER/$MODEL"

# 4) 启动本地 LLM Provider 代理网关（热切换用）
echo "[orchestration] 启动本地 LLM Provider 代理网关..."
PROXY_PORT="${PROXY_PORT:-18880}"
node "$ROOT/scripts/provider-proxy.mjs" --port="$PROXY_PORT" &
PROXY_PID=$!

# 等待代理就绪
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
    echo "[orchestration]   → LLM Provider 代理就绪 (127.0.0.1:$PROXY_PORT)"
    break
  fi
  sleep 1
done

# 5) 设置 preload 劫持 fetch → proxy
export NODE_OPTIONS="--require $ROOT/scripts/preload-fetch-proxy.mjs"
export NODE_PATH="$ROOT/pi/node_modules"

echo ""
echo "[Medical Agentic RAG]  LLM: $PROVIDER/$MODEL (via local proxy)  KB: 134 guidelines"
echo ""

# 6) 启动 Pi Agent
exec "$ROOT/pi/packages/coding-agent/dist/cli.js" \
  --model "$PROVIDER/$MODEL" \
  --system-prompt "$ROOT/prompts/medical-agent.md"
