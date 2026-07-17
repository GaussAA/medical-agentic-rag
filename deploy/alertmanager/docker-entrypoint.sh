#!/bin/sh
set -e
# Alertmanager 渲染入口（镜像无 envsubst，故用 shell 原生变量展开）。
# ALERT_WEBHOOK_URL 缺失时回退本地占位端点（能启动但不推送）；
# 大帅务必在项目根 .env 填写真实 webhook 端点。
cat > /etc/alertmanager/alertmanager.yml <<EOF
global:
  resolve_timeout: 5m

route:
  receiver: webhook
  group_by: ["alertname", "service"]
  group_wait: 30s
  group_interval: 5m
  repeat_interval: 4h

receivers:
  - name: webhook
    webhook_configs:
      - url: "${ALERT_WEBHOOK_URL:-http://localhost:9093/alerts}"
        send_resolved: true
EOF
exec /bin/alertmanager --config.file=/etc/alertmanager/alertmanager.yml
