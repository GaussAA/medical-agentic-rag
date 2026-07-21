# 医疗 Agentic RAG 系统

基于 **Pi Agent (earendil-works/pi)** + **pi-knowledge** 构建的医疗知识问答系统。
知识源为国家卫健委等机构发布的权威诊疗指南（原始 PDF/DOCX，方案 B：弃 MD 中间层，原始文档为唯一真相源）。

## 快速开始

```bash
# 1. 克隆项目
git clone <本项目地址>
cd medical-agentic-rag

# 2. 克隆 Pi 源码并构建（pi/ 已 gitignore，需手动拉取）
git clone https://github.com/git-clone-fresh-here.git pi
# 或使用项目已包含的 pi/（若已有）
cd pi && npm install --ignore-scripts && npm run build && cd ..

# 3. 配置 LLM 网关（免费优先 sensenova，经 provider-proxy 故障转移）
#    复制 .env 模板并填入 SENSENOVA_API_KEYS（免费额度，可留多枚轮询）
cp .env.example .env

# 4. 启动（编排故障转移 + 代理网关 + Pi Agent）
./start.sh
```

默认使用 **sensenova-6.7-flash-lite**（免费）。本地有 LM Studio 时，进入 Pi 后输入 `/model` 可切到 `local/google/gemma-4-e2b`。

## 项目结构

```
medical-agentic-rag/
├── pi/                          # Pi Agent 源码（v0.81.0，.gitignore 排除）
│   └── packages/coding-agent/   # CLI 入口（含 Ctrl+A 归档快捷键）
├── data/                        # 知识库原始文件 + 归一化文本
│   ├── raw/                     # 原始 PDF/DOCX/TXT
│   ├── raw-txt/                 # pdftotext 归一化文本
│   └── kb/                      # 索引文件（.outline / .guide-index / .knowledge-graph）
├── .pi/
│   ├── extensions/              # 医疗自定义扩展（20 个 .ts，100% 测试覆盖）
│   │   ├── provider.*.ts        # Provider（sensenova / agnes / local / failover / query-cache）
│   │   ├── retrieval.*.ts       # 检索（guide-finder / rag-search / kg-search / query-decomposer / medical-infographic）
│   │   ├── safety.*.ts          # 安全护栏（scope-guard / faithfulness-guard / bash-guard / patient-profile / audit-logger / conflict-detector）
│   │   ├── eval.*.ts            # 评测（answer-evaluator / monitor-logger）
│   │   └── state.*.ts           # 状态（conversation-state）
│   └── extensions/lib/          # 共享纯函数模块（按职责拆分子目录）
│       ├── retrieval-router/    # db / matcher / fts / bm25 / fusion
│       ├── phi-crypto/          # crypto / mask / audit
│       ├── llm-judge/           # client / judge
│       ├── guide-router/        # vocab / text / index / route
│       └── feedback-loop/       # signal / aggregate / queue / merge
├── scripts/                     # 按职责分类的运维/评测脚本
│   ├── kb/                      # 知识库管理
│   │   ├── ingest/              # 入库管线（prepare / ingest-raw / rebuild-kb）
│   │   ├── index/               # 索引构建（guide-index / extension-outline / kg-db / fts）
│   │   └── lifecycle/           # 生命周期（deprecate-versions / kb-update）
│   ├── eval/                    # 评测体系
│   │   ├── quality/             # 质量评测（chunk-quality / content-need-alignment / citation-check）
│   │   ├── ab/                  # A/B 评测（ab-prompt-eval / generate-ab-input / ab-extract-diff）
│   │   └── pipeline/            # 评测管线（collect-answers / review-history / feedback-loop）
│   ├── compliance/              # 合规/安全
│   │   ├── audit/               # 审计（compliance-audit / redteam-test）
│   │   └── privacy/             # 隐私（data-lifecycle / verify-patient-profile）
│   ├── ci/                      # CI/运维
│   │   ├── smoke/               # 冒烟测试（smoke-real-link / smoke-providers）
│   │   ├── metrics/             # 监控（metrics-exporter / healthcheck）
│   │   └── hooks/               # git 钩子（pre-push 真实链路冒烟）
│   ├── proxy/                   # LLM 代理网关（provider-proxy / launch-with-failover）
│   ├── service/                 # API 服务（api-server / pi-bridge）
│   └── lib/                     # 共享工具库（config / pi-runner / chinese-heading）
├── tests/                       # 测试（按被测模块镜像源树）
│   ├── unit/
│   │   ├── extensions/          # 扩展测试（provider / retrieval / safety / eval / state）
│   │   ├── lib/                 # 库测试（phi-crypto / llm-judge / retrieval-router / guide-router / ...）
│   │   └── scripts/             # 脚本测试（service / proxy / kb / eval/ab|quality|pipeline）
│   ├── integration/             # 需 LLM Key / DB 的集成测试
│   ├── e2e/                     # 端到端冒烟
│   ├── reports/                 # 测试报告输出
│   └── data/                    # 测试数据（gold-answers.json 等）
├── start.sh / start.bat / start.ps1  # 启动脚本（编排网关 + failover + Pi）
├── Dockerfile / docker-compose.yml    # 容器化部署
└── k8s/                         # K8s 多活部署（T15）
```

## 技术栈

| 组件       | 技术                             | 说明                             |
| ---------- | -------------------------------- | -------------------------------- |
| Agent 框架 | Pi CLI 0.81.0                    | ReAct 智能体循环 + 工具系统      |
| RAG 引擎   | pi-knowledge 0.5.1               | 本地优先，混合检索 + 重排序      |
| LLM 首选   | sensenova-6.7-flash-lite（免费） | 商汤日日新，256K context         |
| LLM 本地   | google/gemma-4-e2b（LM Studio）  | 可选，/model 切换                |
| LLM 兜底   | deepseek-v4-flash（付费）        | provider-proxy failover 自动降级 |
| 嵌入模型   | multilingual-e5-small（本地）    | ~32MB ONNX，零 API Key           |
| 向量存储   | pi-knowledge SQLite              | 本地 `~/.pi/knowledge/`          |
| 运行环境   | Node.js 22.22.2+                 |                                  |

## 启动

### 方式一：一键启动（推荐）

```bash
./start.sh                    # Linux/macOS/Git Bash
start.bat                     # Windows 双击
```

启动编排：

1. 探测健康 Provider → 写入 `.pi/failover-selection.json`
2. 启动 LLM Provider 代理网关（127.0.0.1:18880）
3. 启动 Pi Agent（自动加载全部医疗扩展 + system prompt）

默认模型 `sensenova/sensenova-6.7-flash-lite`（免费），可通过环境变量覆写：

```bash
LLM_PROVIDER=local LLM_MODEL=local/google/gemma-4-e2b ./start.sh
```

### 方式二：Docker 部署

```bash
docker-compose up -d
```

详见 `deploy/README.md`、`k8s/README.md`。

### 首次使用：索引知识库

进入 Pi 交互界面后执行：

```
knowledge_plan { source: "raw" }
knowledge_add { source: "raw", name: "医疗指南" }
knowledge_show
```

## 常用命令

### npm scripts（package.json 注册入口）

**知识库管理：**

- `npm run kb:rebuild` — 重建向量库
- `npm run kb:update check` — 检查过期待刷来源
- `npm run kb:prepare` — 归一化原始文档（PDF/DOCX→TXT）
- `npm run kb:index` — 重建指南索引
- `npm run kb:deprecate` — 检测版本废止
- `npm run kb:entities` — 知识图谱实体抽取

**评测与测试：**

- `npm test` — 全量数据完整性套件
- `npm run test:ci` — CI 门禁（忠实战 fail-closed）
- `npm run eval:judge` — LLM-Judge 四维评测
- `npm run eval:ab` — A/B 提示词对比

**运维：**

- `npm run proxy:start` — 启动 LLM 代理网关
- `npm run failover` — 探测健康 Provider
- `npm run ops:watchdog` — 检测新指南文件
- `npm run compliance:audit` — 合规审计

### Pi 内置命令（交互终端内）

```
/session     — 当前会话信息
/resume      — 切换/恢复历史会话（↑↓选择，Ctrl+A 归档，Ctrl+D 删除）
/export      — 导出会话（HTML/JSONL）
/name        — 重命名当前会话
/fork        — 从历史消息创建分支
/clone       — 克隆当前会话
/tree        — 浏览分支树
/new         — 新建会话
/compact     — 压缩上下文
/model       — 切换 LLM 模型（可选本地/免费/付费）
/webui-start — 启动本地浏览器 Web 端（http://127.0.0.1:31415）
```

### 启动脚本日志解读

```
[Medical Agentic RAG]  LLM: sensenova/sensenova-6.7-flash-lite (via local proxy)
                       Proxy 实际后端: local/google/gemma-4-e2b
```

- **LLM 行**：Pi CLI 实际使用的 Provider/Model（仅用于寻址 proxy，不影响实际路由）
- **Proxy 实际后端**：`provider-proxy` 根据 failover 选择真实转发的后端（本地 LM Studio 可达则优先）

## 扩展包（组合优先）

系统能力由**现成 Pi 生态包 + 极简手写胶水**构成：

- **pi-knowledge** — RAG 引擎，`knowledge_search` 工具
- **pi-web-access** — 联网检索，`web_search` / `fetch_content` 工具
- **pi-subagents** — 多代理并行/委派，`subagent` 工具
- **@firstpick/pi-package-webui** — 本地浏览器 Web 端

## 自定义扩展（20 个 .ts，100% 测试覆盖）

按功能分为四组：

| 分组     | 扩展                                                                                                                                    | 职责                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| Provider | `provider.sensenova.ts` / `agnes.ts` / `local.ts` / `failover.ts` / `query-cache.ts`                                                    | LLM 提供商注册 + 故障转移         |
| 检索     | `retrieval.guide-finder.ts` / `rag-search.ts` / `kg-search-tool.ts` / `query-decomposer.ts` / `medical-infographic.ts`                  | 医疗指南语义路由 + RAG + 知识图谱 |
| 安全     | `safety.scope-guard.ts` / `faithfulness-guard.ts` / `bash-guard.ts` / `patient-profile.ts` / `audit-logger.ts` / `conflict-detector.ts` | 越界拦截、忠实度护栏、PHI 加密    |
| 评测     | `eval.answer-evaluator.ts` / `monitor-logger.ts`                                                                                        | LLM-Judge 四维评测、会话自动归档  |
| 状态     | `state.conversation-state.ts`                                                                                                           | 对话上下文（槽位、澄清计数）      |

## 测试体系

当前测试覆盖率（对应 `scripts/ci/test-aggregate.mjs`）：

| 层级      | 覆盖情况                                         |
| --------- | ------------------------------------------------ |
| 单元测试  | **52 套件全部通过**                              |
| 扩展层    | **20/20（100%）** — 每个 .ts 扩展均有对应测试    |
| lib/ 模块 | **25/26（96%）** — 仅 query-transform 被间接覆盖 |
| script 层 | 14/45 CLI 脚本有独立测试（运维脚本变更频率低）   |
| 冒烟测试  | 24/24 全绿（pre-push 门禁 + 真实 KB 链路）       |

关键测试文件分布：

- `tests/unit/extensions/provider/` — Provider 注册/健康探测
- `tests/unit/extensions/retrieval/` — 路由/检索/缓存
- `tests/unit/extensions/safety/` — 护栏/越界/忠实度
- `tests/unit/lib/` — phi-crypto / llm-judge / guide-router / retrieval-router 等
- `tests/unit/scripts/` — 脚本层单测
- `tests/integration/` — 需 LLM Key 的真链路测试

## 合规体系

| 维度         | 实现                               | 位置                           |
| ------------ | ---------------------------------- | ------------------------------ |
| PHI 静态加密 | AES-256-GCM 认证加密               | `lib/phi-crypto/crypto.mjs`    |
| PII 脱敏     | 手机/身份证/邮箱/姓名脱敏          | `lib/phi-crypto/mask.mjs`      |
| 审计哈希链   | 防篡改哈希链                       | `lib/phi-crypto/audit.mjs`     |
| 被遗忘权     | 画像擦除 + 审计留痕                | `safety.patient-profile.ts`    |
| 忠实度护栏   | LLM-Judge fail-closed，HARD 默认开 | `safety.faithfulness-guard.ts` |
| 越界护栏     | 医疗领域边界拦截                   | `safety.scope-guard.ts`        |
| 会话自动归档 | 超 50 条/30 天自动移入 archive/    | `eval.monitor-logger.ts`       |

## 搜索模式

| 场景               |    模式    | 示例                                             |
| ------------------ | :--------: | ------------------------------------------------ |
| 常规问答           |  `hybrid`  | `rag_search({ query: "...", mode: "hybrid" })`   |
| 高精度（用药剂量） |   `deep`   | `rag_search({ query: "...", mode: "deep" })`     |
| 多指南对比         | `adaptive` | `rag_search({ query: "...", mode: "adaptive" })` |
| 精确术语           |   `fast`   | `rag_search({ query: "...", mode: "fast" })`     |
| 概念搜索           | `semantic` | `rag_search({ query: "...", mode: "semantic" })` |

## 设计原则

1. **零手写 RAG 代码** — RAG 能力完全由 pi-knowledge 提供
2. **本地优先** — 嵌入、向量、存储全部本地化，无需外部服务
3. **隐私友好** — API Key 仅用于 LLM 调用，知识库数据不出本地；PHI 静态加密、日志不记原文、读写留痕
4. **组装优先** — 能用现成生态包解决的绝不手写；仅在医疗合规等不可替代处手写胶水
5. **增量可扩展** — 可随时加装 Pi 生态扩展包，无需改核心代码
