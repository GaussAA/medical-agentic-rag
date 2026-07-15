#!/usr/bin/env bash
# ============================================================
# stop-api.sh — 停止 API 服务
# 策略：先按 .pi/api.pid 树清理，再按监听端口(8088/18880)兜底精准杀。
# 注：Windows Git Bash 无 pkill，故用 netstat + taskkill 端口杀（可靠）。
# ============================================================
set -uo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

PID_FILE=".pi/api.pid"

# 1) 按 pid 文件（可能为空，容错）
if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE" 2>/dev/null || true)"
  if [ -n "$PID" ]; then
    taskkill /PID "$PID" /T /F >/dev/null 2>&1 || true
  fi
  rm -f "$PID_FILE"
fi

# 2) 兜底：按监听端口精准杀（Windows Git Bash 可靠）
for p in 8088 18880; do
  PID=$(netstat -ano 2>/dev/null | grep ":$p " | grep LISTENING | awk '{print $NF}' | head -1)
  if [ -n "$PID" ]; then
    echo "[api] 释放端口 $p (PID=$PID)"
    taskkill /PID "$PID" /T /F >/dev/null 2>&1 || true
  fi
done

echo "[api] 已停止"
