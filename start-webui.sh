#!/usr/bin/env bash
# ============================================================
# start-webui.sh — 无人值守拉起「医疗 Agentic RAG」Web 问答界面
#
# 机制：复用 Pi WebUI 的独立 CLI（pi-webui），它会在无人值守
#       场景下自动 spawn Pi RPC 会话，无需进入 TUI 交互终端，
#       也无需手写 HTTP 服务层。已在本机验证（端口 2s 内 OPEN）。
#
# 用法：
#   ./start-webui.sh                          # 默认仅本机 127.0.0.1:31415
#   WEBUI_PORT=8080 ./start-webui.sh
#   WEBUI_HOST=0.0.0.0 ./start-webui.sh       # 允许局域网访问（须同时开鉴权）
#   WEBUI_REMOTE_AUTH=1 WEBUI_HOST=0.0.0.0 ./start-webui.sh   # 跨设备+PIN 鉴权
#
# 前置：
#   - .env 中已配置 LLM API Key（SENSENOVA_API_KEY 等）
#   - 已安装 WebUI 扩展：pi install npm:@firstpick/pi-package-webui
#   - 知识库已构建（~/.pi/knowledge/knowledge.db）
# ============================================================
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Windows 原生路径（node 在 Windows 下吃 C:/... 形式最稳）
WIN_ROOT="$(pwd -W 2>/dev/null || pwd)"
WIN_HOME="$(cd ~ && pwd -W 2>/dev/null || echo "$HOME")"

# 固定用 managed node 22（与 better-sqlite3 原生模块 ABI / start.sh 一致，避免系统 node 25 加载崩溃）
NODE_BIN="${NODE_BIN:-/c/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node}"
[ -x "$NODE_BIN" ] || NODE_BIN="node"

# 1) 加载 .env（仅导出本项目关心的变量；failover 探测会写 failover-selection.json）
if [ -f .env ]; then
  set -a
  . .env
  set +a
fi

# 1.1) 解析参数：`-d/--background` 后台；`KEY=VALUE` 形式作为环境变量覆盖
#      （支持 ./start-webui.sh -d WEBUI_PORT=8080 与 WEBUI_PORT=8080 ./start-webui.sh -d 两种写法）
BACKGROUND=0
for a in "$@"; do
  case "$a" in
    -d|--background) BACKGROUND=1 ;;
    *=*) export "${a%%=*}"="${a#*=}" ;;
  esac
done

# 2) 选定模型：优先用 failover 探测结果，否则免费档（sensenova-6.7-flash-lite）
PROVIDER="${LLM_PROVIDER:-sensenova}"
MODEL="${LLM_MODEL:-sensenova-6.7-flash-lite}"
if [ -f .pi/failover-selection.json ]; then
  P="$(node -e "try{console.log(require('./.pi/failover-selection.json').provider||'')}catch(e){}" 2>/dev/null || true)"
  M="$(node -e "try{console.log(require('./.pi/failover-selection.json').model||'')}catch(e){}" 2>/dev/null || true)"
  [ -n "$P" ] && PROVIDER="$P"
  [ -n "$M" ] && MODEL="$M"
fi

# 3) 定位 pi-webui 独立启动器（多候选回退）
WUI_BIN=""
for cand in \
  "${PI_WEBU_BIN:-}" \
  "$WIN_HOME/.pi/agent/npm/node_modules/@firstpick/pi-package-webui/bin/pi-webui.mjs" \
  "$HOME/.pi/agent/npm/node_modules/@firstpick/pi-package-webui/bin/pi-webui.mjs" \
  "$(npm root -g 2>/dev/null)/@firstpick/pi-package-webui/bin/pi-webui.mjs" ; do
  if [ -n "$cand" ] && [ -f "$cand" ]; then
    WUI_BIN="$cand"
    break
  fi
done
if [ -z "$WUI_BIN" ]; then
  echo "✗ 未找到 pi-webui，请先执行: pi install npm:@firstpick/pi-package-webui" >&2
  exit 1
fi

# 4) 端口 / 绑定 / system prompt 路径
PORT="${WEBUI_PORT:-31415}"
HOST="${WEBUI_HOST:-127.0.0.1}"
# 远程鉴权：仅在主动暴露到非本机网络时开启（PIN 保护）
if [ "${WEBUI_REMOTE_AUTH:-0}" = "1" ]; then
  REMOTE_ARG="--remote-auth"
else
  REMOTE_ARG="--no-remote-auth"
fi
PROMPT="$WIN_ROOT/.pi/prompts/medical-agent.md"
[ -f "$PROMPT" ] || PROMPT="$ROOT/.pi/prompts/medical-agent.md"
if [ ! -f "$PROMPT" ]; then
  echo "✗ 找不到 system prompt: .pi/prompts/medical-agent.md" >&2
  exit 1
fi

# 5) 拉起（standalone 模式自动 spawn Pi RPC，加载 .pi/extensions 全部医疗扩展）
echo ""
echo "[Medical Agentic RAG · WebUI]"
echo "  模型 : $PROVIDER/$MODEL"
echo "  界面 : http://$HOST:$PORT/"
echo "  工作区: $WIN_ROOT"
echo ""

ARGS=(--cwd "$WIN_ROOT" --host "$HOST" --port "$PORT" "$REMOTE_ARG" \
       -- --model "$PROVIDER/$MODEL" --system-prompt "$PROMPT")

# 后台模式：-d / --background / WEBUI_BACKGROUND=1（脱离终端、写 PID、可长期运行）
if [ "$BACKGROUND" = "1" ] || [ "${WEBUI_BACKGROUND:-0}" = "1" ]; then
  mkdir -p .pi/logs
  nohup "$NODE_BIN" "$WUI_BIN" "${ARGS[@]}" > .pi/logs/webui.log 2>&1 &
  echo $! > .pi/webui.pid
  echo "[webui] 后台启动 PID=$(cat .pi/webui.pid) → http://$HOST:$PORT/"
  echo "[webui] 日志: .pi/logs/webui.log   停止: ./stop-webui.sh"
  # 探活
  for i in $(seq 1 30); do
    if curl -sf -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
      echo "[webui] 就绪 (${i}s)"; break
    fi
    sleep 1
  done
  exit 0
fi

exec "$NODE_BIN" "$WUI_BIN" "${ARGS[@]}"
