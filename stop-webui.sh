#!/usr/bin/env bash
# ============================================================
# stop-webui.sh — 停止后台运行的医疗 Agentic RAG Web 服务
# 用法：./stop-webui.sh
# ============================================================
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PID_FILE=".pi/webui.pid"

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    echo "[webui] 停止 PID=$PID (含子进程树) ..."
    # /T 杀进程树（含 Pi RPC 子进程）；Git Bash 下 taskkill 用 // 转义
    taskkill //PID "$PID" //T //F >/dev/null 2>&1 \
      || kill -9 -"$PID" 2>/dev/null \
      || pkill -9 -f "pi-coding-agent/dist/cli.js --mode rpc" 2>/dev/null \
      || true
  fi
  rm -f "$PID_FILE"
  echo "[webui] 已停止"
else
  echo "[webui] 未找到 $PID_FILE，尝试按进程名清理 ..."
  pkill -f "pi-package-webui/bin/pi-webui.mjs" 2>/dev/null || true
  pkill -f "pi-coding-agent/dist/cli.js --mode rpc" 2>/dev/null || true
  echo "[webui] 已尝试清理"
fi
