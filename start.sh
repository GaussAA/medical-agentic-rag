#!/usr/bin/env bash
# ============================================================
# start.sh — Medical Agentic RAG 统一启动入口
#
# 子命令:
#   start.sh                    默认 = tui：启动 Pi TUI 交互终端（代理 + Pi CLI）
#   start.sh tui                同上
#   start.sh webui              启动 Web 界面（pi-webui standalone，免 TUI）
#   start.sh api                启动 HTTP API 服务（api-server）
#   start.sh stop               停止所有服务
#   start.sh stop webui         仅停止 WebUI
#   start.sh stop api           仅停止 API
#   start.sh status             查看运行状态
#
# 通用参数:
#   -d / --background            后台运行（仅 webui / api 有效）
#   KEY=VALUE                    环境变量覆盖（如 WEBUI_PORT=8080）
#
# 前置条件:
#   - .env 已配置 LLM API Key
#   - 已安装 pi + 扩展包（pi-knowledge, pi-webui 等）
#   - 知识库已构建（~/.pi/knowledge/knowledge.db）
#
# 旧脚本迁移:
#   start-webui.sh → start.sh webui
#   start-api.sh   → start.sh api
#   stop-webui.sh  → start.sh stop webui
#   stop-api.sh    → start.sh stop api
# ============================================================
set -euo pipefail

# ─── 通用函数 ────────────────────────────────────────────────

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

# Windows 原生路径（node 在 Windows 下吃 C:/... 格式）
WIN_ROOT="$(pwd -W 2>/dev/null || pwd)"
WIN_HOME="$(cd ~ && pwd -W 2>/dev/null || echo "$HOME")"

# managed node 22（与 better-sqlite3 ABI 一致）
# 解析顺序：env 覆盖 → $HOME 受管路径（跨用户可移植）→ 本机 JaNiy 固定路径（兜底兼容）→ 系统 node
NODE_BIN="${NODE_BIN:-}"
if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
  for cand in \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2/node" \
    "$HOME/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
    "/c/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node" \
    "C:/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
    "$(command -v node)"; do
    [ -n "$cand" ] && [ -x "$cand" ] && { NODE_BIN="$cand"; break; } || true
  done
fi
[ -x "$NODE_BIN" ] || NODE_BIN="node"

load_env() {
  if [ -f .env ]; then
    set -a
    . .env
    set +a
  fi
}

parse_args() {
  CMD="${1:-tui}"
  CMD_ARGS=()
  shift 2>/dev/null || true
  for a in "$@"; do
    case "$a" in
      -d|--background) BACKGROUND=1 ;;
      *=*) export "${a%%=*}"="${a#*=}" ;;
      *) CMD_ARGS+=("$a") ;;
    esac
  done
}

# ─── 子命令：tui（默认，原 start.sh）─────────────────────────

cmd_tui() {
  load_env
  local PROXY_PORT="${PROXY_PORT:-18880}"

  # 探测健康 Provider
  echo "[orchestration] 探测健康 Provider..."
  node scripts/proxy/launch-with-failover.mjs >/dev/null 2>&1 || true

  # 读 failover 结果
  local BACKEND_LABEL=""
  local SEL_FILE=".pi/failover-selection.json"
  if [ -f "$SEL_FILE" ]; then
    local BP=$(node -e "const j=require('./.pi/failover-selection.json');console.log(j.provider||'')")
    local BM=$(node -e "const j=require('./.pi/failover-selection.json');console.log(j.model||'')")
    [ -n "$BP" ] && BACKEND_LABEL="${BP}/${BM}"
  fi
  local PROVIDER="${LLM_PROVIDER:-sensenova}"
  local MODEL="${LLM_MODEL:-sensenova-6.7-flash-lite}"

  # failover 探测结果覆写默认模型
  # 注意：仅当 Provider 是 Pi 已注册的（sensenova/agnes/deepseek）时才覆写，
  # 否则维持默认免费模型。local 等 proxy 专用 Provider 不直接对 Pi 可见，
  # 强传会导致 Error: Model not found。
  if [ -f "$SEL_FILE" ]; then
    local FP=$(node -e "try{console.log(require('./.pi/failover-selection.json').provider||'')}catch(e){}" 2>/dev/null || true)
    local FM=$(node -e "try{console.log(require('./.pi/failover-selection.json').model||'')}catch(e){}" 2>/dev/null || true)
    if [ -n "$FP" ] && [ -n "$FM" ]; then
      case "$FP" in
        sensenova|agnes|deepseek)
          PROVIDER="$FP"
          MODEL="$FM"
          ;;
        *)
          # local 等 proxy 专用 Provider——不传给 Pi CLI，保持默认免费模型
          # proxy 会自行根据 failover 选择路由到实际后端
          ;;
      esac
    fi
  fi

  # 清理残留 proxy
  echo "[orchestration] 清理残留 LLM Provider 代理（端口 $PROXY_PORT）..."
  local OLD_PID
  OLD_PID=$(netstat -ano 2>/dev/null | grep ":${PROXY_PORT} " | grep "LISTENING" | awk '{print $NF}' | head -1) || true
  if [ -n "$OLD_PID" ] && [ "$OLD_PID" != "0" ]; then
    taskkill -pid "$OLD_PID" -f 2>/dev/null || true
    sleep 1
  fi

  # 启动 proxy
  echo "[orchestration] 启动本地 LLM Provider 代理网关..."
  mkdir -p .pi/logs
  node scripts/proxy/provider-proxy.mjs --port="$PROXY_PORT" >> ".pi/logs/proxy.log" 2>&1 &
  local PROXY_PID=$!

  for i in $(seq 1 30); do
    if curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1; then
      echo "[orchestration]   → LLM Provider 代理就绪 (127.0.0.1:$PROXY_PORT)"
      break
    fi
    sleep 1
  done

  export NODE_PATH="$WIN_ROOT/pi/node_modules;$WIN_ROOT/.pi/npm/node_modules"
  export PI_KNOWLEDGE_DIR="$WIN_ROOT/.pi/knowledge"

  echo ""
  echo "[Medical Agentic RAG]  LLM: $PROVIDER/$MODEL (via local proxy)"
  echo "                       Proxy 实际后端: ${BACKEND_LABEL:-（无 failover，默认 sensenova）}"
  echo ""

  exec "$NODE_BIN" \
    --require "$WIN_ROOT/scripts/proxy/preload-fetch-proxy.mjs" \
    "$WIN_ROOT/pi/packages/coding-agent/dist/cli.js" \
    --model "$PROVIDER/$MODEL" \
    --system-prompt "$WIN_ROOT/.pi/prompts/medical-agent.md" \
    --session-dir "$WIN_ROOT/.pi/sessions"
}

# ─── 子命令：webui（原 start-webui.sh）──────────────────────

cmd_webui() {
  load_env
  local BACKGROUND=0
  for a in "${CMD_ARGS[@]}" "$@"; do
    case "$a" in -d|--background) BACKGROUND=1 ;; *=*) export "${a%%=*}"="${a#*=}" ;; esac
  done

  # 模型选择（优先 failover，仅限 Pi 已注册 Provider）
  local PROVIDER="${LLM_PROVIDER:-sensenova}"
  local MODEL="${LLM_MODEL:-sensenova-6.7-flash-lite}"
  if [ -f .pi/failover-selection.json ]; then
    local P M
    P="$(node -e "try{console.log(require('./.pi/failover-selection.json').provider||'')}catch(e){}" 2>/dev/null || true)"
    M="$(node -e "try{console.log(require('./.pi/failover-selection.json').model||'')}catch(e){}" 2>/dev/null || true)"
    if [ -n "$P" ] && [ -n "$M" ]; then
      case "$P" in
        sensenova|agnes|deepseek)
          PROVIDER="$P"
          MODEL="$M"
          ;;
      esac
    fi
  fi

  # 定位 pi-webui
  local WUI_BIN=""
  for cand in \
    "${PI_WEBU_BIN:-}" \
    "$WIN_HOME/.pi/agent/npm/node_modules/@firstpick/pi-package-webui/bin/pi-webui.mjs" \
    "$HOME/.pi/agent/npm/node_modules/@firstpick/pi-package-webui/bin/pi-webui.mjs" \
    "$(npm root -g 2>/dev/null)/@firstpick/pi-package-webui/bin/pi-webui.mjs"; do
    [ -n "$cand" ] && [ -f "$cand" ] && { WUI_BIN="$cand"; break; } || true
  done
  if [ -z "$WUI_BIN" ]; then
    echo "✗ 未找到 pi-webui，请先执行: pi install npm:@firstpick/pi-package-webui" >&2
    exit 1
  fi

  local PORT="${WEBUI_PORT:-31415}"
  local HOST="${WEBUI_HOST:-127.0.0.1}"
  local REMOTE_ARG="--no-remote-auth"
  [ "${WEBUI_REMOTE_AUTH:-0}" = "1" ] && REMOTE_ARG="--remote-auth"

  local PROMPT="$WIN_ROOT/.pi/prompts/medical-agent.md"
  [ -f "$PROMPT" ] || PROMPT="$ROOT/.pi/prompts/medical-agent.md"
  if [ ! -f "$PROMPT" ]; then
    echo "✗ 找不到 system prompt: .pi/prompts/medical-agent.md" >&2
    exit 1
  fi

  echo ""
  echo "[Medical Agentic RAG · WebUI]"
  echo "  模型 : $PROVIDER/$MODEL"
  echo "  界面 : http://$HOST:$PORT/"
  echo "  工作区: $WIN_ROOT"
  echo ""

  local ARGS=(--cwd "$WIN_ROOT" --host "$HOST" --port "$PORT" "$REMOTE_ARG" \
         -- --model "$PROVIDER/$MODEL" --system-prompt "$PROMPT")

  if [ "$BACKGROUND" = "1" ] || [ "${WEBUI_BACKGROUND:-0}" = "1" ]; then
    mkdir -p .pi/logs
    nohup "$NODE_BIN" "$WUI_BIN" "${ARGS[@]}" > .pi/logs/webui.log 2>&1 &
    echo $! > .pi/webui.pid
    echo "[webui] 后台启动 PID=$(cat .pi/webui.pid) → http://$HOST:$PORT/"
    echo "[webui] 日志: .pi/logs/webui.log   停止: start.sh stop webui"
    for i in $(seq 1 30); do
      if curl -sf -o /dev/null "http://127.0.0.1:$PORT/" 2>/dev/null; then
        echo "[webui] 就绪 (${i}s)"; break
      fi
      sleep 1
    done
    return 0
  fi

  exec "$NODE_BIN" "$WUI_BIN" "${ARGS[@]}"
}

# ─── 子命令：api（原 start-api.sh）───────────────────────────

cmd_api() {
  load_env
  local BACKGROUND=0
  for a in "${CMD_ARGS[@]}" "$@"; do
    case "$a" in -d|--background) BACKGROUND=1 ;; *=*) export "${a%%=*}"="${a#*=}" ;; esac
  done

  export PI_KNOWLEDGE_WATCH=false

  # 探测 Provider
  echo "[api] 探测 Provider 健康态…"
  "$NODE_BIN" scripts/proxy/launch-with-failover.mjs >/dev/null 2>&1 || true

  local API_BIN="$WIN_ROOT/scripts/service/api-server.mjs"
  if [ ! -f "$API_BIN" ]; then
    echo "✗ 未找到 scripts/service/api-server.mjs" >&2
    exit 1
  fi

  local PORT="${API_PORT:-8080}"
  local HOST="${API_HOST:-127.0.0.1}"

  echo ""
  echo "[Medical Agentic RAG · API]"
  echo "  地址 : http://$HOST:$PORT/"
  echo "  接口 : POST /api/v1/ask   POST /api/v1/model   GET /api/v1/models"
  echo "  运维 : GET /healthz   GET /metrics   GET /api/v1/sessions"
  echo "  工作区: $WIN_ROOT"
  echo ""

  mkdir -p .pi/logs

  if [ "$BACKGROUND" = "1" ] || [ "${API_BACKGROUND:-0}" = "1" ]; then
    MEDICAL_API_RUN=1 nohup "$NODE_BIN" "$API_BIN" > .pi/logs/api.log 2>&1 &
    echo $! > .pi/api.pid
    echo "[api] 后台启动 PID=$(cat .pi/api.pid) → http://$HOST:$PORT/"
    echo "[api] 日志: .pi/logs/api.log   停止: start.sh stop api"
    for i in $(seq 1 40); do
      if curl -sf -o /dev/null "http://127.0.0.1:$PORT/healthz" 2>/dev/null; then
        echo "[api] 就绪 (${i}s)"; break
      fi
      sleep 1
    done
    return 0
  fi

  NODE_ENV=production MEDICAL_API_RUN=1 exec "$NODE_BIN" "$API_BIN"
}

# ─── 子命令：stop ────────────────────────────────────────────

cmd_stop() {
  local WHAT="${1:-all}"

  if [ "$WHAT" = "all" ] || [ "$WHAT" = "webui" ]; then
    local PID_FILE=".pi/webui.pid"
    if [ -f "$PID_FILE" ]; then
      local PID
      PID="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$PID" ]; then
        echo "[webui] 停止 PID=$PID (含子进程树) ..."
        taskkill //PID "$PID" //T //F >/dev/null 2>&1 \
          || kill -9 -"$PID" 2>/dev/null \
          || pkill -9 -f "pi-coding-agent/dist/cli.js --mode rpc" 2>/dev/null \
          || true
      fi
      rm -f "$PID_FILE"
      echo "[webui] 已停止"
    else
      echo "[webui] 未找到 PID 文件，尝试按进程名清理 ..."
      pkill -f "pi-package-webui/bin/pi-webui.mjs" 2>/dev/null || true
      pkill -f "pi-coding-agent/dist/cli.js --mode rpc" 2>/dev/null || true
      echo "[webui] 已尝试清理"
    fi
  fi

  if [ "$WHAT" = "all" ] || [ "$WHAT" = "api" ]; then
    local PID_FILE=".pi/api.pid"
    if [ -f "$PID_FILE" ]; then
      local PID
      PID="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$PID" ]; then
        taskkill /PID "$PID" /T /F >/dev/null 2>&1 || true
      fi
      rm -f "$PID_FILE"
    fi
    # 兜底端口清理
    for p in 8088 18880; do
      local PPID
      PPID=$(netstat -ano 2>/dev/null | grep ":$p " | grep LISTENING | awk '{print $NF}' | head -1)
      if [ -n "$PPID" ]; then
        echo "[api] 释放端口 $p (PID=$PPID)"
        taskkill /PID "$PPID" /T /F >/dev/null 2>&1 || true
      fi
    done
    echo "[api] 已停止"
  fi
}

# ─── 子命令：status ──────────────────────────────────────────

cmd_status() {
  echo "=== Medical Agentic RAG 服务状态 ==="
  for svc in webui api; do
    local PID_FILE=".pi/${svc}.pid"
    if [ -f "$PID_FILE" ]; then
      local PID
      PID="$(cat "$PID_FILE" 2>/dev/null || true)"
      if [ -n "$PID" ] && tasklist //FI "PID eq $PID" 2>/dev/null | grep -q "$PID"; then
        echo "  ${svc}: 运行中 (PID=$PID)"
      else
        echo "  ${svc}: PID 文件存在但进程已退出 (PID=$PID)"
      fi
    else
      echo "  ${svc}: 未启动"
    fi
  done
  echo "  工作区: $WIN_ROOT"
  echo "  日志:   .pi/logs/"
  echo "  KB:     ~/.pi/knowledge/"
}

# ─── 入口 ────────────────────────────────────────────────────

BACKGROUND=0
parse_args "$@"

case "$CMD" in
  tui|"")     cmd_tui ;;
  webui)      cmd_webui ;;
  api)        cmd_api ;;
  stop)       cmd_stop "${CMD_ARGS[0]:-all}" ;;
  status)     cmd_status ;;
  *)
    echo "用法: start.sh <tui|webui|api|stop|status> [选项]"
    echo "  start.sh                   默认 TUI 模式（Pi 交互终端）"
    echo "  start.sh webui             启动 Web 界面"
    echo "  start.sh api               启动 API 服务"
    echo "  start.sh stop [webui|api]  停止服务"
    echo "  start.sh status            查看状态"
    echo ""
    echo "选项:"
    echo "  -d, --background            后台运行（webui / api）"
    echo "  KEY=VALUE                   覆盖环境变量"
    exit 1
    ;;
esac
