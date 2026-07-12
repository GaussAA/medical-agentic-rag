#!/usr/bin/env bash
# ============================================================
# start.sh — Medical Agentic RAG 启动脚本（Git Bash 专用）
# 优先免费模型（sensenova-6.7-flash-lite），失败回退 deepseek
#
# 注意：所有传给 node 的路径用相对路径（已 cd 到项目根目录）
# 或 Windows 格式（C:/...），不能用 /c/... 格式——
# Git Bash 命令行参数转换不作用于 NODE_OPTIONS 或 -e 代码内的字符串。
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
node scripts/proxy/launch-with-failover.mjs >/dev/null 2>&1 || true

# 3) 读 failover 结果（failover-selection.json 字段为 provider/model）
WIN_ROOT="$(pwd -W)"  # C:/WorkSpace/...（正斜杠，Windows node 原生识别）
SEL_FILE=".pi/failover-selection.json"
if [ -f "$SEL_FILE" ]; then
  PROVIDER=$(node -e "const j=require('./.pi/failover-selection.json');console.log(j.provider||'')")
  MODEL=$(node -e "const j=require('./.pi/failover-selection.json');console.log(j.model||'')")
else
  PROVIDER="${LLM_PROVIDER:-deepseek}"
  MODEL="${LLM_MODEL:-deepseek-v4-flash}"
fi
echo "[orchestration]   → 选定 Provider: $PROVIDER/$MODEL"

# 4) 清理残留 proxy（避免端口冲突）
PROXY_PORT="${PROXY_PORT:-18880}"
echo "[orchestration] 清理残留 LLM Provider 代理（端口 $PROXY_PORT）..."
OLD_PID=$(netstat -ano 2>/dev/null | grep ":${PROXY_PORT} " | grep "LISTENING" | awk '{print $NF}' | head -1) || true
if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
  taskkill -pid "$OLD_PID" -f 2>/dev/null || true
  sleep 1
fi

echo "[orchestration] 启动本地 LLM Provider 代理网关..."
mkdir -p logs   # 确保日志目录存在；proxy 输出重定向至 logs/proxy.log，避免污染交互终端
node scripts/proxy/provider-proxy.mjs --port="$PROXY_PORT" >> "logs/proxy.log" 2>&1 &
PROXY_PID=$!

# 等待代理就绪
for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
    echo "[orchestration]   → LLM Provider 代理就绪 (127.0.0.1:$PROXY_PORT)"
    break
  fi
  sleep 1
done

# 5) 设置 preload 劫持 fetch → proxy（$WIN_ROOT 为正斜杠 C:/...，无需引号嵌套）
export NODE_OPTIONS="--require $WIN_ROOT/scripts/proxy/preload-fetch-proxy.mjs"
export NODE_PATH="$WIN_ROOT/pi/node_modules"

echo ""
echo "[Medical Agentic RAG]  LLM: $PROVIDER/$MODEL (via local proxy)  KB: 134 guidelines"
echo ""

# 6) 启动 Pi Agent（用 managed node v22.22.2，与 better-sqlite3 原生模块版本匹配）
NODE_BIN="${NODE_BIN:-/c/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node}"
exec "$NODE_BIN" "$WIN_ROOT/pi/packages/coding-agent/dist/cli.js" \
  --model "$PROVIDER/$MODEL" \
  --system-prompt "$WIN_ROOT/prompts/medical-agent.md"
