# ============================================================
# 医疗 Agentic RAG — 单容器部署
# 基于已验证机制：容器内用 Pi WebUI 独立 CLI（pi-webui）无人值守
# 拉起 Web 服务 + Pi RPC 会话，自动加载本项目 .pi/extensions 全部医疗扩展。
# 无需手写 HTTP 层，无需 Redis/Qdrant/Kafka 等外部组件。
# ============================================================
# 锁定到特定 Node 22.22.2，避免 node:22 浮动标签意外升级导致 ABI 不兼容
FROM node:22.22.2-bookworm-slim

# better-sqlite3 等原生模块构建依赖
RUN apt-get update && apt-get install -y --no-install-recommends \
    python3 make g++ git curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV PI_AGENT_HOME=/root/.pi
ENV APP=/app
WORKDIR $APP

# 1) 项目文件（含 .pi/extensions、.pi/prompts、scripts；pi/ 已被 .dockerignore 排除）
COPY . .

# 2) 项目依赖（better-sqlite3 等；会触发原生编译）
RUN npm install

# 3) 安装 Pi CLI、Pi 引擎、扩展包（pi-webui 自动加载本地 .pi/extensions）
#    注意：不能使用 pi install 命令（pi v2 下为空壳），
#    改为直接 npm install -g 安装所需包。
#    ⚠️ 版本硬性锁定（P0-1 修复）：此前 `npm install -g pi` 无版本约束，
#    构建时拉取 npm latest，镜像在不同时间构建结果不可复现、存在供应链风险。
#    下方版本为 2026-07-24 实查，须与 package.json 的 'piRuntime' 字段保持一致；
#    升级任一包须同步更新两处并重新验证。
#    注意: pi-knowledge 0.5.6 依赖 better-sqlite3@12.11.1（ABI 127，兼容 Node 22.22.2）
RUN npm install -g pi@2.0.5 \
    @earendil-works/pi-coding-agent@0.81.0 \
    pi-knowledge@0.5.6 \
    pi-web-access@0.13.0 \
    pi-subagents@0.34.0 \
    @firstpick/pi-package-webui@0.6.8 \
 && mkdir -p /app/pi/packages \
 && ln -sfn /usr/local/lib/node_modules/@earendil-works/pi-coding-agent /app/pi/packages/coding-agent

# 知识库通过卷挂载（docker-compose 已配置）；如需从零构建见 deploy/README.md
EXPOSE 31415 8080

COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
COPY deploy/docker-entrypoint-api.sh /usr/local/bin/docker-entrypoint-api.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint-api.sh

ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
