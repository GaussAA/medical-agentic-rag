#!/usr/bin/env bash
# start-admin-panel.sh
# 启动知识库管理面板（端口 3001）
# 用法: bash start-admin-panel.sh [--port 3001]

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"

# 转成 Windows 路径（node.exe 需要）
WIN_PROJECT="$(cygpath -w "$PROJECT_DIR" 2>/dev/null || echo "$PROJECT_DIR")"

PORT="${2:-3001}"

# 优先用 managed Node.js 22
NODE_BIN=""
for candidate in \
  "$HOME/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  "/c/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node.exe" \
  "C:/Users/JaNiy/.workbuddy/binaries/node/versions/22.22.2/node.exe"; do
  if [ -f "$candidate" ]; then
    NODE_BIN="$candidate"
    break
  fi
done

if [ -z "$NODE_BIN" ]; then
  # 回退到 PATH 中的 node
  NODE_BIN="node"
fi

echo "━━━ 知识库管理面板 ━━━"
echo "  项目目录: $PROJECT_DIR"
echo "  Node:     $($NODE_BIN --version)"
echo "  端口:     $PORT"
echo ""

"$NODE_BIN" "$WIN_PROJECT/scripts/admin/kb-admin-server.mjs" --port="$PORT"
