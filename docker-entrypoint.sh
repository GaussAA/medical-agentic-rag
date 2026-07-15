#!/usr/bin/env bash
# ============================================================
# docker-entrypoint.sh — 容器内拉起医疗 Agentic RAG Web 界面
# 等价 start-webui.sh 的容器版：定位 pi-webui → exec 拉起。
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

# 2) 模型（默认免费档；可用 LLM_PROVIDER/LLM_MODEL 覆盖）
PROVIDER="${LLM_PROVIDER:-sensenova}"
MODEL="${LLM_MODEL:-sensenova-6.7-flash-lite}"
PORT="${WEBUI_PORT:-31415}"
HOST="${WEBUI_HOST:-0.0.0.0}"
# 远程鉴权：跨网络暴露时务必开启（PIN 保护）；默认关闭（仅在可信网络/前置反代鉴权时）
if [ "${WEBUI_REMOTE_AUTH:-0}" = "1" ]; then
  REMOTE_ARG="--remote-auth"
else
  REMOTE_ARG="--no-remote-auth"
fi

# 3) 定位 pi-webui 独立启动器
WUI_BIN="$(ls /root/.pi/agent/npm/node_modules/@firstpick/pi-package-webui/bin/pi-webui.mjs 2>/dev/null || true)"
if [ -z "$WUI_BIN" ]; then
  echo "✗ 未找到 pi-webui，请确认 Dockerfile 中已执行 pi install npm:@firstpick/pi-package-webui" >&2
  exit 1
fi

PROMPT="$APP/.pi/prompts/medical-agent.md"
if [ ! -f "$PROMPT" ]; then
  echo "✗ 找不到 system prompt: $PROMPT" >&2
  exit 1
fi

echo ""
echo "[Medical Agentic RAG · WebUI]"
echo "  模型 : $PROVIDER/$MODEL"
echo "  界面 : http://$HOST:$PORT/"
echo ""

# 禁用启动期版本探测（离线/容器内避免阻塞）
export PI_WEBUI_PI_LATEST_VERSION_URL="${PI_WEBUI_PI_LATEST_VERSION_URL:-http://127.0.0.1:9/nope}"

exec node "$WUI_BIN" \
  --cwd "$APP" \
  --host "$HOST" \
  --port "$PORT" \
  "$REMOTE_ARG" \
  -- --model "$PROVIDER/$MODEL" \
     --system-prompt "$PROMPT"
