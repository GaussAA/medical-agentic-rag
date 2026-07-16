#!/usr/bin/env bash
# ============================================================
# k8s-deploy-check.sh — K8s 部署就绪检查
#
# 在 apply 到集群前运行，检查 yaml 一致性、占位符遗漏、
# 依赖关系、Secret 注入、cert-manager/ingress 配置。
#
# 用法：
#   bash deploy/k8s-deploy-check.sh
#   bash deploy/k8s-deploy-check.sh --strict  # 硬卡退出码
# ============================================================
set -euo pipefail

K8S_DIR="$(cd "$(dirname "$0")/../k8s" && pwd)"
ERRORS=0
WARNS=0
STRICT=false

if [ "${1:-}" = "--strict" ]; then STRICT=true; fi

red()   { echo "🔴 $1"; }
yellow() { echo "🟡 $1"; }
green()  { echo "🟢 $1"; }

echo "=========================================="
echo "  K8s 部署就绪检查"
echo "  目录: $K8S_DIR"
echo "=========================================="
echo ""

# ---- 1) 文件完整性 ----
echo "--- 1/7 文件完整性 ---"
REQUIRED=(
  namespace.yaml configmap.yaml secret.yaml
  deployment.yaml service.yaml ingress.yaml hpa.yaml
  network-policy.yaml cert-manager-issuer.yaml
  kb-pvc.yaml kb-build-job.yaml
)
MISSING=0
for f in "${REQUIRED[@]}"; do
  if [ ! -f "$K8S_DIR/$f" ]; then
    red "缺少必需文件: $f"
    MISSING=$((MISSING + 1))
    ERRORS=$((ERRORS + 1))
  else
    green "✓ $f"
  fi
done

# ---- 2) 占位符检查 ----
echo "--- 2/7 占位符/生产值检查 ---"
PLACEHOLDERS=$(grep -rn "REPLACE_WITH\|change_me\|your-\|example\." "$K8S_DIR" 2>/dev/null || true)
if [ -n "$PLACEHOLDERS" ]; then
  yellow "发现未替换的占位符:"
  echo "$PLACEHOLDERS" | while read -r line; do echo "    $line"; done
  WARNS=$((WARNS + 1))
else
  green "✓ 无占位符残留"
fi

# ---- 3) Namespace 一致性 ----
echo "--- 3/7 Namespace 一致性 ---"
NS="medical-rag"
MISMATCH=0
for y in "$K8S_DIR"/*.yaml; do
  f=$(basename "$y")
  # 跳过本身
  [ "$f" = "namespace.yaml" ] && continue
  # 检查 metadata.namespace 或类似字段
  if grep -q "namespace:" "$y" 2>/dev/null; then
    if ! grep -q "namespace: $NS" "$y" 2>/dev/null; then
      yellow "$f 中的 namespace 不是 $NS"
      MISMATCH=$((MISMATCH + 1))
    fi
  fi
done
if [ "$MISMATCH" -eq 0 ]; then
  green "✓ 所有 yaml namespace 一致 ($NS)"
else
  yellow "有 $MISMATCH 个文件 namespace 需确认"
  WARNS=$((WARNS + 1))
fi

# ---- 4) Secret 引用 ----
echo "--- 4/7 Secret/ConfigMap 引用 ---"
# 检查 deployment.yaml 中引用的 secret 是否存在
SECRET_REFS=$(grep -oP 'secretKeyRef:\s*\n\s*name:\s*\K\S+' "$K8S_DIR/deployment.yaml" 2>/dev/null || true)
if [ -n "$SECRET_REFS" ]; then
  echo "$SECRET_REFS" | while read -r name; do
    if grep -q "name: ${name}$" "$K8S_DIR/secret.yaml" 2>/dev/null; then
      green "  ✓ Secret '$name' 定义存在"
    else
      red "  ✗ Secret '$name' 在 secret.yaml 中未定义"
      ERRORS=$((ERRORS + 1))
    fi
  done
fi

# ---- 5) Ingress + cert-manager ----
echo "--- 5/7 Ingress & TLS ---"
if [ -f "$K8S_DIR/ingress.yaml" ]; then
  if grep -q "cert-manager.io" "$K8S_DIR/ingress.yaml" 2>/dev/null; then
    if [ -f "$K8S_DIR/cert-manager-issuer.yaml" ]; then
      green "✓ ingress 引用 cert-manager + issuer 存在"
    else
      red "✗ ingress 引用 cert-manager 但 issuer 文件缺失"
      ERRORS=$((ERRORS + 1))
    fi
  else
    yellow "⚠ ingress 未配置 cert-manager（等保 TLS 要求）"
    WARNS=$((WARNS + 1))
  fi
fi

# ---- 6) NetworkPolicy ----
echo "--- 6/7 NetworkPolicy ---"
if [ -f "$K8S_DIR/network-policy.yaml" ]; then
  # 检查是否默拒入站
  if grep -q "podSelector:" "$K8S_DIR/network-policy.yaml" && grep -q "Ingress" "$K8S_DIR/network-policy.yaml"; then
    green "✓ NetworkPolicy 存在（含入站规则）"
  else
    yellow "⚠ NetworkPolicy 需确认是否包含默认拒绝入站"
    WARNS=$((WARNS + 1))
  fi
else
  yellow "⚠ 无 NetworkPolicy（等保三级要求东西向隔离）"
  WARNS=$((WARNS + 1))
fi

# ---- 7) HPA 配置 ----
echo "--- 7/7 HPA ---"
if [ -f "$K8S_DIR/hpa.yaml" ]; then
  MIN_REPLICAS=$(grep -oP 'minReplicas:\s*\K\d+' "$K8S_DIR/hpa.yaml" || echo "?")
  MAX_REPLICAS=$(grep -oP 'maxReplicas:\s*\K\d+' "$K8S_DIR/hpa.yaml" || echo "?")
  green "✓ HPA: min=$MIN_REPLICAS max=$MAX_REPLICAS"
else
  yellow "⚠ 无 HPA yaml"
  WARNS=$((WARNS + 1))
fi

echo ""
echo "=========================================="
echo "  检查完成: 错误 $ERRORS 警告 $WARNS"
echo "=========================================="

if [ "$ERRORS" -gt 0 ]; then
  echo "🔴 $ERRORS 个错误需修复后再部署"
  [ "$STRICT" = true ] && exit 1
fi
if [ "$WARNS" -gt 0 ]; then
  echo "🟡 $WARNS 个建议项可选择性处理"
fi
exit 0
