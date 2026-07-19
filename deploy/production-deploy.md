# 医疗 Agentic RAG · 生产部署手册

> 方案：轻量云服务器 + Docker + Cloudflare Tunnel（推荐）
> 编制：司马　|　审查者：大帅
> 月费预估：云服务器 ~30-68 元 + 域名 ~3-5 元/月 = **最低约 35 元/月**
> 耗时：采购 1h → 配置 1h → KB迁移 15min → 验收 15min

---

## 目录

1. [采购清单](#1-采购清单)
2. [服务器初始化](#2-服务器初始化)
3. [项目与知识库就绪](#3-项目与知识库就绪)
4. [Docker 构建与启动](#4-docker-构建与启动)
5. [Cloudflare 配置](#5-cloudflare-配置)
6. [Tunnel 隧道部署](#6-tunnel-隧道部署)
7. [验收与故障排查](#7-验收与故障排查)
8. [日常运维](#8-日常运维)

---

## 1. 采购清单

### 1.1 云服务器

| 推荐 | 配置 | 月费 | 用途 |
|------|------|------|------|
| **腾讯云轻量应用服务器** | 2C2G / 40GB SSD / 4Mbps | ~30 元（新人价） | Docker 跑全栈 |
| 备用：阿里云 ECS | 2C2G / 40GB SSD | ~49 元 | 同上 |
| 最低：腾讯云轻量 | 2C4G / 80GB SSD | ~68 元 | 跑大模型更宽裕 |

**选购要点：**
- 操作系统选 **Ubuntu 22.04 LTS**（后续所有命令以此为准）
- 带宽 ≥ 3Mbps 即可（API 返回文本为主，非大文件传输）
- 地域选离你最近的机房（广深/上海/北京）
- **先领新人优惠再下单**，通常首年 30 元/月

### 1.2 域名

- 推荐购买渠道：腾讯云 DNSPod / 阿里云万网 / NameSilo
- 推荐后缀：`.com`（约 50 元/年）或 `.cn`（约 30 元/年）
- 买完域名后**将 NS 服务器改为 Cloudflare 的 DNS**（详见 §5）

### 1.3 合计月费

```
云服务器      30-68 元/月
域名摊销       3-5 元/月
LLM API Key  0-30 元/月（sensenova 免费额先用，不够则开 deepseek 付费）
─────────────────────────────────────
合计          约 35-100 元/月
```

---

## 2. 服务器初始化

### 2.1 SSH 登录

```bash
# 腾讯云控制台「重置密码」获取初始 SSH 密码
ssh root@你的服务器IP

# 建议立即设置 SSH 密钥登录（更安全）
ssh-copy-id root@你的服务器IP
```

### 2.2 系统更新与基础工具

```bash
apt-get update && apt-get upgrade -y
apt-get install -y curl git ufw htop unzip
```

### 2.3 安装 Docker

```bash
# 使用官方脚本一键安装
curl -fsSL https://get.docker.com -o get-docker.sh
sh get-docker.sh

# 验证
docker --version       # 应 ≥ 24.x
docker compose version  # 应 ≥ 2.x

# 加入 docker 组（避免每次 sudo）
usermod -aG docker $USER
# 退出 SSH 重新登录后生效
```

### 2.4 防火墙

```bash
# 仅开放所需端口
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh               # 22 端口
ufw allow 31415             # WebUI（可选，CF Tunnel 可代替）
ufw allow 8080              # API（可选，CF Tunnel 可代替）
ufw --force enable

# 如果只用 Cloudflare Tunnel（推荐），只开 SSH 即可
# ufw allow ssh && ufw --force enable
```

> **关于端口：** 若使用 Cloudflare Tunnel（§6），隧道走的是**出站连接**，
> 不需要在防火墙上开 80/443 等入站端口，仅保留 SSH（22）足矣——这是 Tunnel
> 相对传统反代的一大安全优势。

---

## 3. 项目与知识库就绪

### 3.1 克隆项目

```bash
cd /opt
git clone <你的仓库地址> medical-rag
cd medical-rag
```

> 如果仓库未公开，需配置 SSH deploy key 或使用 personal access token。

### 3.2 准备 .env 文件

```bash
cp .env.example .env
vi .env
```

**必填项：**

```ini
# ---------- LLM API Keys ----------
SENSENOVA_API_KEY=sk-你的sensenova密钥
DEEPSEEK_API_KEY=sk-你的deepseek兜底密钥

# ---------- 密钥（生产环境务必设置） ----------
PATIENT_DATA_KEY=<openssl rand -hex 32>   # 粘贴生成的 64 位 hex
AUDIT_HMAC_KEY=<openssl rand -hex 32>

# ---------- API 鉴权 ----------
API_TOKEN=<openssl rand -hex 32>          # 前端通过 localStorage 配置

# ---------- 告警 webhook ----------
ALERT_WEBHOOK_URL=https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx  # 或飞书/钉钉
```

生成密钥的快捷命令：

```bash
# 在服务器上执行，输出直接粘贴到 .env
echo "PATIENT_DATA_KEY=$(openssl rand -hex 32)"
echo "AUDIT_HMAC_KEY=$(openssl rand -hex 32)"
echo "API_TOKEN=$(openssl rand -hex 32)"
```

### 3.3 迁移知识库

知识库是部署的核心资产，有以下三种方式：

#### 方式 A：从本机 scp 过去（推荐，最快）

```bash
# 在本机（Windows Git Bash 或 WSL）执行：
# 压缩本地 KB
cd ~/.pi
tar -czf knowledge.tar.gz knowledge/

# 传到服务器（替换为你的服务器 IP）
scp knowledge.tar.gz root@你的服务器IP:/opt/medical-rag/

# 在服务器上解压
cd /opt/medical-rag
tar -xzf knowledge.tar.gz -C /root/.pi/
```

#### 方式 B：在服务器重建

```bash
# 适用于服务器上有 raw/ 原始文档的情况
# 耗时较长（索引 135 份文档约 5-15 分钟）
npm run kb:prepare
npm run kb:outline
npm run kb:index

# 然后进入 Pi 交互界面执行 knowledge_plan + knowledge_add
node pi/packages/coding-agent/dist/cli.js
# 在 Pi > 提示符下执行：
#   knowledge_plan { source: "raw" }
#   knowledge_add { source: "raw", name: "医疗指南" }
#   exit
```

#### 方式 C：容器自动挂载（已集成）

`docker-compose.yml` 的 `provision-kb` 服务会自动将宿主机
`~/.pi/knowledge` 挂载到容器，无需手动拷贝。确保 `~/.pi/knowledge/knowledge.db`
存在即可。

### 3.4 验证 KB 文件

```bash
# 确认 KB 文件已经存在
ls -lh /root/.pi/knowledge/
# 应该看到 knowledge.db（通常在 50-200MB）
```

---

## 4. Docker 构建与启动

### 4.1 构建镜像

```bash
cd /opt/medical-rag

# 首次构建（会编译 better-sqlite3 原生模块，耗时 3-5 分钟）
docker compose -f docker-compose.yml build

# 确认镜像已生成
docker images | grep medical-agentic-rag
```

### 4.2 启动服务

```bash
# 启动全部服务（API + WebUI + 监控栈）
docker compose -f docker-compose.yml up -d

# 观察启动日志
docker compose logs -f --tail=50
```

### 4.3 验证各服务

```bash
# API 服务
curl -s http://127.0.0.1:8080/healthz | head -5
# 应返回 JSON：{"status":"ok","piReady":true,...}

# WebUI
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:31415/
# 应返回 200

# 提问测试
curl -X POST http://127.0.0.1:8080/api/v1/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"原发性肝癌的高危人群有哪些？","sessionId":"deploy-test"}'
# 应返回含 answer 和 citations 的 JSON
```

> ⚠️ 首次启动 `provision-kb` 容器会等待 KB 就绪。
> 如果宿主机 `/root/.pi/knowledge` 为空，启动日志会提示
> `WARN_host_KB_missing_instances_start_empty`，服务仍会正常启动但无知识库。
> 此时需按 §3.3 补充 KB 后 `docker compose down && up`。

---

## 5. Cloudflare 配置

### 5.1 注册 Cloudflare

- 打开 https://dash.cloudflare.com/sign-up
- 注册免费账号
- 添加你的域名（例如 `your-domain.com`）

### 5.2 修改 NS 记录

Cloudflare 会给出两个 nameserver 地址，例如：

```
dahlia.ns.cloudflare.com
kurt.ns.cloudflare.com
```

去你的域名注册商控制台，将 NS 记录改为这两条。
**等待生效：** 通常 5-30 分钟，全球 DNS 传播可能需要几小时。

### 5.3 DNS 配置

在 Cloudflare Dashboard → DNS → Records 添加：

| 类型 | 名称 | 目标（IP/域名） | 代理状态 |
|------|------|-----------------|----------|
| CNAME | `medical` | `你的-tunnel-id.cfargotunnel.com` | ☁️ 橙色（代理） |

> ⚠️ `你的-tunnel-id.cfargotunnel.com` 这个地址要在 §6 创建完 Tunnel 后才出现。
> 如果你暂时没创建 Tunnel，也可以先指向服务器 IP（灰色云朵），等 Tunnel 建好后再改：
>
> | 类型 | 名称 | 目标 | 代理状态 |
> |------|------|------|----------|
> | A | `medical` | `你的服务器公网IP` | ☁️ 橙色 |

### 5.4 SSL/TLS 配置

Cloudflare Dashboard → SSL/TLS → Overview：

- **SSL/TLS encryption mode**：选择 **Full (strict)**
- **Origin Server** → **Create Certificate**：创建 Origin CA 证书
  - 私钥和证书会下载一次，保存好
  - 稍后需要填入 Docker 容器或 Caddy 配置中

> 实际上使用 Tunnel 时 TLS 在 CF 边缘终止，源服务器到 Tunnel 之间走的是
> CF 内部加密隧道，源服务器本身不需要配置 SSL 证书。选择 Full 即可。

---

## 6. Tunnel 隧道部署

### 6.1 安装 cloudflared

```bash
# 在服务器上安装 cloudflared（Linux amd64）
curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cloudflared.deb
dpkg -i /tmp/cloudflared.deb

# 验证
cloudflared --version
```

### 6.2 登录与创建 Tunnel

```bash
# 浏览器登录 Cloudflare 账号
cloudflared tunnel login
# 会打印一个 URL，在浏览器打开，选择你的域名授权

# 创建隧道（名称自定义）
cloudflared tunnel create medical-rag

# 创建成功后，会在 ~/.cloudflared/ 下生成一个 <tunnel-id>.json 文件
# 记录这个 tunnel-id（例如 abc12345-xxxx-xxxx-xxxx-xxxxxxxxxxxx）

# 验证
cloudflared tunnel list
# 应显示你刚创建的 tunnel
```

### 6.3 配置 Tunnel 指向本地服务

```bash
cat > ~/.cloudflared/config.yml << 'EOF'
# Cloudflare Tunnel 配置
tunnel: <你的-tunnel-id>
credentials-file: /root/.cloudflared/<你的-tunnel-id>.json

ingress:
  # API 服务 → https://medical.your-domain.com/api/*
  - hostname: medical.your-domain.com
    service: http://127.0.0.1:8080
    # 如果同时暴露 WebUI：
    # - hostname: medical-webui.your-domain.com
    #   service: http://127.0.0.1:31415

  # 最后的兜底规则（必须保留）
  - service: http_status:404
EOF
```

> **注意：** Tunnel ingress 配置的是**域名到本地端口的映射**。
> 如果只暴露 API（端口 8080），外部访问 `https://medical.your-domain.com/api/v1/ask` 即可。
> 前端暂时可以由 Pi WebUI (31415) 提供 Web 界面。

### 6.4 配置 DNS → Tunnel

回到 Cloudflare Dashboard → DNS，把之前 A/CNAME 记录的目标改为 Tunnel：

```bash
# 在服务器上查看 tunnel ID
cloudflared tunnel list

# 用 cloudflared 自动创建 DNS 记录
cloudflared tunnel route dns <你的-tunnel-id> medical.your-domain.com
```

这条命令会自动在 Cloudflare DNS 中添加一条 CNAME 记录指向 Tunnel。

### 6.5 启动 Tunnel（测试）

```bash
# 前台启动验证
cloudflared tunnel run medical-rag
# 看到 "Connection established" 即成功
```

### 6.6 部署为系统服务（长期运行）

```bash
# 安装为 systemd 服务
cloudflared tunnel --loglevel info install

# 启动并设置开机自启
systemctl start cloudflared
systemctl enable cloudflared

# 查看状态
systemctl status cloudflared

# 查看日志
journalctl -u cloudflared -f --no-pager -n 50
```

### 6.7 验证公网访问

```bash
# 从任意机器访问
curl -s https://medical.your-domain.com/healthz
# 应返回 JSON 状态

# 提问测试
curl -X POST https://medical.your-domain.com/api/v1/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"2型糖尿病的诊断标准是什么？","sessionId":"prod-test"}'
```

---

## 7. 验收与故障排查

### 7.1 全面验收清单

| # | 检查项 | 验证方法 | 预期结果 |
|---|--------|----------|----------|
| 1 | API 可用 | `curl https://medical.your.domain/healthz` | JSON `{"status":"ok"}` |
| 2 | 知识库加载 | 提问一个指南中的问题 | 返回有引用的回答 |
| 3 | 越界拒答 | 提问「帮我写首诗」 | 返回 scope 拒答 |
| 4 | HTTPS 正常 | 浏览器打开 URL | 绿锁 + 无安全警告 |
| 5 | 首次响应 | API 第一个问题的响应时间 | ≤ 15s（含 Pi 预热） |
| 6 | 重复提问 | 带 sessionId 多轮对话 | 上下文连贯 |
| 7 | 鉴权生效 | 不加 `Authorization` 调 POST | 返回 401 |

### 7.2 常见问题

| 现象 | 原因 | 解决 |
|------|------|------|
| `docker compose up` 后 API 返回 502 | Pi 仍在预热（首次启动 15-30s） | 等待 readinessProbe 通过 |
| `provision-kb` 报 KB missing | 宿主机无 KB 文件 | 按 §3.3 迁移 KB，然后 `docker compose down && up` |
| `curl https://...` 返回 521 | Cloudflare 无法连接源站 | 检查 cloudflared 是否运行：`systemctl status cloudflared` |
| Tunnel 频繁断开 | 云服务器 NAT 超时 | cloudflared 自动重连，观察 `journalctl -u cloudflared -f` |
| LLM 返回空 | sensenova 免费额度耗尽 | 检查 `.env` 中的 API Key，或自动降级 deepseek |
| 回答质量差 | 路由未命中正确指南 | 检查评测基线：`node tests/unit/eval-bench.mjs` |

---

## 8. 日常运维

### 8.1 常用命令一览

```bash
# 查看服务状态
docker compose ps
systemctl status cloudflared

# 查看 API 日志
docker compose logs -f --tail=50 medical-api

# 查看监控
docker compose logs -f --tail=20 prometheus

# 重启 API 服务
docker compose restart medical-api

# 更新项目（拉取最新代码后重建）
cd /opt/medical-rag
git pull
docker compose build
docker compose up -d

# 查看审计日志
cat /opt/medical-rag/.pi/logs/audit-$(date +%Y-%m-%d).ndjson | head

# 备份知识库
tar -czf /backup/knowledge-$(date +%Y-%m-%d).tar.gz -C /root/.pi knowledge/
```

### 8.2 监控面板

| 服务 | 地址 | 说明 |
|------|------|------|
| Prometheus | `http://服务器IP:9090`（内网） | 指标查询与告警规则 |
| Grafana | `http://服务器IP:3000`（内网） | 审计与安全监控仪表盘 |
| Alertmanager | `http://服务器IP:9093`（内网） | 告警管理 |

> 默认 Grafana 管理员：`admin` / 密码见 `.env` 的 `GRAFANA_ADMIN_PASSWORD`。

### 8.3 知识库更新

当有新的指南文档加入 `raw/` 目录后：

```bash
cd /opt/medical-rag

# 1) 重建索引（宿主机）
npm run kb:prepare
npm run kb:outline
npm run kb:index

# 2) 重建向量库（经 Pi 运行时）
node pi/packages/coding-agent/dist/cli.js
#   knowledge_plan { source: "raw" }
#   knowledge_add { source: "raw", name: "医疗指南" }

# 3) 重启容器使新 KB 生效
docker compose down && docker compose up -d
```

### 8.4 备份策略

| 频率 | 内容 | 命令 |
|------|------|------|
| 每日 | 审计日志 | `tar -czf /backup/audit-$(date +%Y-%m-%d).tar.gz /opt/medical-rag/.pi/logs/` |
| 每周 | 知识库 | `tar -czf /backup/kb-$(date +%Y-%m-%d).tar.gz -C /root/.pi knowledge/` |
| 每月 | 完整项目 | `tar -czf /backup/full-$(date +%Y-%m).tar.gz /opt/medical-rag/` |

建议将备份同步到 Cloudflare R2（免费 10GB）：

```bash
# 安装 rclone
curl https://rclone.org/install.sh | bash

# 配置 R2（需在 Cloudflare Dashboard → R2 创建 bucket）
rclone config
# 选择 S3 兼容 → 填入 R2 的 endpoint / access key / secret key

# 定时备份
rclone copy /backup/kb-2026-07-18.tar.gz r2:medical-rag-backups/
```

---

## 附录 A：一键部署脚本

将以下内容保存为 `deploy/bootstrap.sh`，上传到服务器后直接执行即可完成全部初始化：

```bash
#!/bin/bash
set -euo pipefail

echo "=== 医疗 Agentic RAG - 生产部署初始化 ==="

# 1) 检测 OS
if ! grep -qi "ubuntu" /etc/os-release 2>/dev/null; then
  echo "错误：本脚本仅支持 Ubuntu"
  exit 1
fi

# 2) 安装 Docker
if ! command -v docker &>/dev/null; then
  echo ">> 安装 Docker..."
  curl -fsSL https://get.docker.com | bash
  usermod -aG docker $USER
fi

# 3) 安装 cloudflared
if ! command -v cloudflared &>/dev/null; then
  echo ">> 安装 cloudflared..."
  curl -L https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb -o /tmp/cf.deb
  dpkg -i /tmp/cf.deb
fi

# 4) 设置防火墙
ufw default deny incoming
ufw default allow outgoing
ufw allow ssh
ufw --force enable

echo "=== 基础环境就绪 ==="
echo "下一步："
echo "  1. cloudflared tunnel login"
echo "  2. cloudflared tunnel create medical-rag"
echo "  3. cd /opt/medical-rag && cp .env.example .env && vi .env"
echo "  4. docker compose up -d"
echo "  5. cloudflared tunnel route dns <tunnel-id> medical.your-domain.com"
echo "  6. cloudflared tunnel install && systemctl start cloudflared"
```

---

## 附录 B：架构示意图

```
┌──────── 用户浏览器 ────────┐
│  https://medical.your.domain │
└──────────┬─────────────────┘
           │
┌──────────▼─────────────────┐
│  Cloudflare 全球网络        │  ← DNS解析 → CDN加速 → DDoS防护 → WAF
│  · 自动 SSL/TLS 证书        │
│  · 隐藏源站真实 IP           │
└──────────┬─────────────────┘
           │（加密隧道）
┌──────────▼─────────────────┐
│  cloudflared (服务器端)      │  ← systemd 守护，出站连接
│  127.0.0.1:8080 → API       │
│  127.0.0.1:31415 → WebUI    │
└──────────┬─────────────────┘
           │
    ┌──────┴──────┐
    │             │
┌───▼────┐  ┌────▼───┐
│ medical │  │medical │
│ -rag    │  │-api    │
│ :31415  │  │:8080   │
└────────┘  └───┬────┘
                │
         ┌──────┴───────┐
         │   Pi Agent    │ ← 串行处理，KB 本地
         │ · rag_search  │
         │ · 5道安全护栏 │
         │ · 审计日志    │
         │ · PHI 加密    │
         └──────────────┘
```

> **安全要点：**
> - 云服务器仅开 22 端口（SSH），无 80/443 等入站端口
> - TLS 终止于 Cloudflare 边缘，源站永远不直接暴露
> - API 鉴权通过 `API_TOKEN` Bearer Token
> - PHI 数据落地使用 AES-256-GCM 认证加密
> - 所有 LLM 调用都经过故障转移网关，免费优先
