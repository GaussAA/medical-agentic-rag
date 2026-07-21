# 医疗 Agentic RAG · 部署与运行（落地轻量方案）

> 编制：司马　|　状态：**可运行（本机已验证）**
> 本方案取代 `docs/infrastructure-deployment-plan-v2.md` 的 Redis/Qdrant/Kafka/Neo4j/ES/Prometheus/Nginx 七栈规划——该重组件栈已被本项目 P2 战役判定为「从未 compose up 的死重」并删除（`scripts/infra/` 已不存在）。落地优先采用**单容器 + Pi WebUI standalone** 的轻量路径。

---

## 1. 它是什么 / 怎么跑起来的

- 复用 **Pi WebUI 独立 CLI（`pi-webui`）**：可在**无人值守**场景下自动 spawn Pi RPC 会话并拉起本地 Web 服务，**无需进入 TUI 终端，也无需手写 HTTP 服务层**。
- 启动后，Pi 自动加载本项目 `.pi/extensions` 下的全部医疗扩展（`rag_search`、五道安全护栏、`pi-knowledge`、`pi-web-access`、`pi-subagents` 等），并套用 `.pi/prompts/medical-agent.md` 医疗 System Prompt。
- 用户通过浏览器访问 Web 界面即可问答；知识检索由本地 `pi-knowledge` 完成，PHI 加密/审计等合规能力照常生效。

> 本机实测：`pi-webui --cwd <项目根> --port 31417` 启动后 **2 秒内端口 OPEN（HTTP 200）**，日志确认 Pi RPC 与全部扩展已加载。

---

## 2. 本地一键运行（无需 Docker）

### 前置条件

1. 已安装 WebUI 扩展：`pi install npm:@firstpick/pi-package-webui`
2. `.env` 中已配置 LLM API Key（如 `SENSENOVA_API_KEY=...`）
3. 知识库已构建（默认位于用户 HOME 的 `~/.pi/knowledge/knowledge.db`）

### 启动

```bash
# 前台（终端关闭即停）
./start.sh webui

# 后台（脱离终端，写 PID，可长期运行）
./start.sh webui -d

# 停止
./start.sh stop webui

# Windows cmd
start.bat webui
```

打开浏览器：**http://localhost:31415/**

可选环境变量：

- `WEBUI_PORT`（默认 31415）
- `WEBUI_HOST`（**本地脚本默认 `127.0.0.1` 仅本机**；需局域网/容器暴露设 `0.0.0.0`）
- `WEBUI_REMOTE_AUTH=1`（跨网络暴露时开启 Remote PIN 鉴权）
- `LLM_PROVIDER` / `LLM_MODEL`（默认 `sensenova/sensenova-6.7-flash-lite` 免费档）
- `NODE_BIN`（默认 managed node 22，与 better-sqlite3 原生 ABI 一致；缺失自动回退 `node`）

---

## 2.5 Agent 服务化 HTTP API（T8）

把 Pi RPC 会话包成干净的「提交问题 → 拿结构化回答」接口，便于被其他系统/前端直接调用，无需浏览器。

### 启动

```bash
./start.sh api                    # 前台（终端关闭即停）
./start.sh api -d                # 后台守护（写 .pi/api.pid，日志 .pi/logs/api.log）
./start.sh stop api              # 停止
API_PORT=9090 API_TOKEN=xxxx ./start.sh api -d   # 自定义端口 + 开启 Bearer 鉴权
```

> API 服务会**自行 spawn Pi RPC 子进程**（受控 managed Node 22 + `--require preload-fetch-proxy.mjs` 劫持 LLM 调用到本地代理网关），并**自举 `provider-proxy`**，无需手动起 proxy。这与 `start.sh` 的运行形态一致（与 WebUI 路径不同——WebUI 不走 proxy preload，因与 pi-webui 进程冲突）。

### 接口

| 方法 | 路径               | 说明                                                                                                                                                                        |
| ---- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| POST | `/api/v1/ask`      | 提问。Body：`{question, sessionId?, patientProfile?, timeoutMs?}`。返回结构化 JSON：`{answer, citations[], evidence[], safety{guardHits[],blocked}, stats, model, traceId}` |
| POST | `/api/v1/model`    | **零重启热切换模型**。`{provider, model, sessionId?}` → 返回生效后的 `model`                                                                                                |
| GET  | `/api/v1/models`   | 当前可用模型列表                                                                                                                                                            |
| GET  | `/api/v1/sessions` | 活跃会话（sessionId → worker 状态、空闲时长）                                                                                                                               |
| GET  | `/healthz`         | 存活探针（含 Pi 状态、uptime、活跃会话数）                                                                                                                                  |
| GET  | `/metrics`         | Prometheus 指标（复用同一审计日志采集）                                                                                                                                     |

### 关键能力

- **结构化返回**：`answer` 为最终回答文本；`citations` 从 `rag_search` 等工具原始结果抽取来源/标题/章节；`evidence` 为工具调用清单；`safety.guardHits` 汇总五道护栏命中，`blocked` 标识是否被拒答。
- **熔断 + 重试**：每会话独立 `CircuitBreaker`（连续失败达阈值熔断、冷却后半开探针恢复），`ask` 外层带一次指数退避重试；熔断打开返回 `429`。
- **多租户会话**：`sessionId` 映射到独立 Pi worker（懒启动、空闲回收、并发上限 `API_MAX_SESSIONS` 默认 8）；无 `sessionId` 复用默认共享 worker，天然支持多轮对话。
- **鉴权**：设 `API_TOKEN` 后所有写接口需 `Authorization: Bearer <token>`；未设则开放（务必仅绑定 `127.0.0.1`）。

### 调用示例

```bash
curl -X POST http://127.0.0.1:8080/api/v1/ask \
  -H 'Content-Type: application/json' \
  -d '{"question":"2型糖尿病合并 CKD3 期如何选降糖药？","sessionId":"sess-001"}'

# 热切换模型（无需重启）
curl -X POST http://127.0.0.1:8080/api/v1/model \
  -H 'Content-Type: application/json' \
  -d '{"provider":"deepseek","model":"deepseek-v4-flash"}'
```

---

## 3. 容器化运行（Docker / 可移植部署）

### 前置条件

- 宿主机已构建好知识库（见第 4 节），或挂载已有 `~/.pi/knowledge`
- `.env` 中已配置 LLM API Key（compose 通过 `env_file` 注入容器）

### 构建并启动

```bash
docker compose up --build        # 首次构建（会 pi install 扩展包，需联网）
docker compose up -d             # 后台运行
docker compose down              # 停止
```

访问：**http://localhost:31415/**（Web 界面）与 **http://localhost:8080/**（HTTP API）。

健康检查：`node scripts/ci/metrics/healthcheck.mjs http://127.0.0.1:31415/`（输出 JSON 状态，退出码 0/1）。compose 已用该脚本作 `healthcheck` + `restart: unless-stopped`。`medical-api` 服务健康检查指向 `http://127.0.0.1:8080/healthz`。

### 指标（Prometheus）

容器内已暴露 `:19100/metrics`（审计事件计数、安全护栏命中、最近事件时间）。本地可单独启动导出器：

```bash
node scripts/ci/metrics/metrics-exporter.mjs      # 默认 :19100，读 .pi/logs/audit-*.ndjson
```

### 监控栈（Prometheus + Grafana，docker-compose 集成）

`docker compose up --build` 后自动拉起三服务：

| 服务       | 端口    | 说明                                                                  |
| ---------- | ------- | --------------------------------------------------------------------- |
| Prometheus | `:9090` | 抓取 `medical-rag:19100` + `medical-api:19100`，保留 30 天            |
| Grafana    | `:3000` | 预配置 Prometheus 数据源 + 「审计与安全监控」仪表盘（免登录只读视图） |

仪表盘包含：

- 审计事件率（5m 滑动，按类型区分）
- 安全护栏命中率（越界拦截用红色突出）
- 最后事件距现在（秒，感知进程健康）
- 审计事件分布（1h 率堆叠柱状图，按 Web / API 分）

如需修改 Grafana 配置，编辑 `deploy/grafana/` 下对应文件，`docker compose restart grafana` 生效。

### 镜像构成

- 基础：`node:22-bookworm-slim` + 原生构建工具（better-sqlite3）
- `npm install` 项目依赖
- `pi install` 四个扩展包：pi-knowledge / pi-web-access / pi-subagents / @firstpick/pi-package-webui
- 复制项目（含 `.pi/extensions`、`.pi/prompts`、`scripts`）
- 入口 `docker-entrypoint.sh` 等价 `start-webui.sh` 逻辑

> 容器启动期会禁用 Pi 版本探测（`PI_WEBUI_PI_LATEST_VERSION_URL` 指向不可达地址），避免离线阻塞。

---

## 4. 知识库构建（全新环境）

若宿主机尚无 `~/.pi/knowledge/knowledge.db`：

```bash
# 1) 归一化原始文档 + 重建索引
npm run kb:prepare
npm run kb:outline
npm run kb:index

# 2) 构建向量库（经 Pi 运行时）
node pi/packages/coding-agent/dist/cli.js   # 进入 Pi 后执行：
#   knowledge_plan { source: "raw" }
#   knowledge_add { source: "raw", name: "医疗指南" }
```

或将已有 `~/.pi/knowledge` 整个目录复制到目标机的 `$HOME/.pi/knowledge`，再挂载/运行（推荐，最省时）。

---

## 5. 安全与暴露说明

- **本地脚本默认绑定 `127.0.0.1`**（仅本机，无暴露警告）。需局域网/容器访问时设 `WEBUI_HOST=0.0.0.0`，此时 WebUI 会提示「exposed to the network」，属正常安全提醒。
- **跨网络暴露务必开启鉴权**：设 `WEBUI_REMOTE_AUTH=1`（Remote PIN 保护），或前置反向代理 + 鉴权。Pi WebUI 自身具备 trust-boundary 控制，但默认不对外设防——切勿在公网裸暴露。
- 容器（`docker-compose`）默认 `0.0.0.0` + `no-remote-auth`，仅适合本机/可信网络；若映射端口到公网，请在 `environment` 加 `WEBUI_REMOTE_AUTH=1`。
- LLM API Key 仅用于模型调用，知识库不外传；PHI 静态加密、日志不记原文、审计留痕等合规能力在 Web 路径下同样生效。
- 当前形态**不走** `scripts/proxy/provider-proxy.mjs` 的 fetch 劫持（该 preload 与 pi-webui 进程冲突会导致 WebUI 启动失败），改为**直接使用 `.env` 中的 API Key**（Pi 原生读取）。Provider 故障转移仍由 `launch-with-failover` 选模型后传入。

---

## 6. 与旧部署规划的关系

| 维度     | 旧方案（deployment-plan-v2）                      | 本轻量方案                                                                |
| -------- | ------------------------------------------------- | ------------------------------------------------------------------------- |
| 形态     | Redis/Qdrant/Kafka/Neo4j/ES/Prometheus/Nginx 七栈 | 单容器 + Pi WebUI standalone                                              |
| 状态     | **已被删除（死重）**                              | 已验证可跑                                                                |
| 适用     | 未实际 compose up                                 | 立即可用                                                                  |
| 后续增强 | —                                                 | 等保三级、私有 LLM、K8s 多活（见路线图 T11/T14/T15）；**T8 服务化已完成** |

> 路线图中的「Agent 服务化（T8）」已完成（见 §2.5）：提供 `/api/v1/ask` 等干净接口、熔断+重试、零重启模型热切换、多租户会话池。剩余「私有化 LLM（T11）/ 等保三级（T14）/ K8s 多活（T15）」属于产品化与规模化阶段，可在本可跑形态之上逐步叠加。
