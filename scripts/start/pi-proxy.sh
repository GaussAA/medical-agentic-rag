#!/usr/bin/env bash
# ============================================================
# scripts/start/pi-proxy.sh — 通过 Provider Proxy 启动 Pi，确保所有 LLM 调用
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

ROOT="$(cd "$(dirname "$0")" && cd ../.. && pwd)"
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
EMBED_PORT="${EMBED_PORT:-18881}"

# ── 检查 Provider Proxy 是否运行 ──
proxy_healthy() {
  curl -sf "http://127.0.0.1:$PROXY_PORT/health" >/dev/null 2>&1
}

# ── 检查本地嵌入服务是否运行（llm-wiki 混合语义召回用，可选） ──
embed_healthy() {
  curl -sf "http://127.0.0.1:$EMBED_PORT/health" >/dev/null 2>&1
}

# ── 加载 .env（provider-proxy / embed-server 均需 API Key 环境） ──
if [ -f .env ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env
  set +a
fi

# v0.84.1+ 修复：Pi 的 EnvHttpProxyAgent 自动走系统代理，sensenova 等国内端点经
# mihomo 会被拒（Forbidden code 16）→ 流式断连 + 长超时。Provider 域名加入 NO_PROXY 直连。
export NO_PROXY="token.sensenova.cn,api.deepseek.com,apihub.agnes-ai.com,${NO_PROXY:-}"
export no_proxy="$NO_PROXY"

# ── 如果嵌入服务未运行，启动它（本地 e5-small，零成本；失败不阻断主流程） ──
if ! embed_healthy; then
  echo "[pi-proxy] 本地嵌入服务未运行，正在启动 (127.0.0.1:$EMBED_PORT)..."
  mkdir -p .pi/logs
  "$NODE_BIN" --import "file://$WIN_ROOT/.pi/embed-proxy-init.mjs" \
    scripts/local-embed-server.mjs --port="$EMBED_PORT" >> ".pi/logs/embed-server.log" 2>&1 &
  EMBED_PID=$!
  for i in $(seq 1 30); do
    if embed_healthy; then
      echo "[pi-proxy]   → 嵌入服务就绪 (PID $EMBED_PID)"
      break
    fi
    sleep 1
  done
  if ! embed_healthy; then
    echo "[pi-proxy] ⚠️ 嵌入服务启动失败（不影响主流程，混合语义召回降级为纯词法）"
  fi
fi

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

export NODE_PATH="$WIN_ROOT/pi/node_modules;$WIN_ROOT/.pi/npm/node_modules"
export PI_KNOWLEDGE_DIR="$WIN_ROOT/.pi/knowledge"
export PI_KNOWLEDGE_RERANKER="hf:Xenova/bge-reranker-base"
export PI_KNOWLEDGE_RERANKER_RAW_LOGITS="true"  # 原生 raw logits 支持（v0.7.0+，无需补丁）

echo "[pi-proxy] LLM: $PROVIDER/$MODEL (via local proxy 127.0.0.1:$PROXY_PORT)"

# ── 通过 proxy 启动 Pi（非交互模式或者交互模式）──
# 轻量化工具集：排除管理/写入型重工具，降 input tokens（实测 -52%）
EXCLUDE_TOOLS="${EXCLUDE_TOOLS:-wiki_bootstrap,wiki_capture_source,wiki_ingest,wiki_ensure_page,wiki_lint,wiki_rebuild_meta,wiki_reindex_embeddings,wiki_log_event,wiki_watch,wiki_retro,wiki_observe,knowledge_plan,knowledge_configure,knowledge_add,knowledge_update,knowledge_remove,knowledge_export,knowledge_import,knowledge_clear,subagent,subagent_wait,subagent_gate,subagent_supervisor,intercom,workspace_session_summaries,generate_medical_infographic,decompose_query}"
exec "$NODE_BIN" \
  --require "$WIN_ROOT/scripts/proxy/preload-fetch-proxy.mjs" \
  "$WIN_ROOT/pi/packages/coding-agent/dist/cli.js" \
  --model "$PROVIDER/$MODEL" \
  --system-prompt "$WIN_ROOT/.pi/prompts/medical-agent.md" \
  --exclude-tools "$EXCLUDE_TOOLS" \
  --session-dir "$WIN_ROOT/.pi/sessions" \
  "$@"
