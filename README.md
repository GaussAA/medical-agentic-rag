# 医疗 Agentic RAG 系统

基于 **Pi Agent (earendil-works/pi)** + **pi-knowledge** 构建的医疗知识问答系统。
知识源为 **135 份国家卫生健康委员会发布的权威诊疗指南（原始 PDF/DOCX，`.doc` 老格式经 antiword 抽文本后纳入；方案 B：弃 MD 中间层，原始文档为唯一真相源；随源目录增长）**。

## 快速开始

```bash
# 1. 克隆 Pi 源码
git clone https://github.com/earendil-works/pi.git

# 2. 安装 Pi 依赖并构建
cd pi && npm install --ignore-scripts && npm run build && cd ..

# 3. 安装 RAG 引擎
pi install npm:pi-knowledge
pi install npm:pi-web-access
pi install npm:@firstpick/pi-package-webui
pi install npm:pi-subagents

# 4. 复制启动配置
cp start.example.bat start.bat
# 编辑 start.bat 填入你的 API Key

# 5. 首次启动后索引知识库
# 在 Pi 交互界面中执行:
#   knowledge_plan { source: "medical-raw" }
#   knowledge_add { source: "medical-raw", name: "医疗指南" }
```

## 项目结构

```
medical-agentic-rag/
├── pi/                          # Pi Agent 源码（.gitignore，单独管理）
│   ├── packages/
│   │   ├── ai/                  # 统一 LLM API
│   │   ├── agent/               # Agent 运行时（ReAct loop）
│   │   ├── coding-agent/        # CLI 入口
│   │   └── tui/                 # 终端 UI
│   └── ...
├── medical-raw/                 # 135 份原始医疗指南（PDF/DOCX/.doc→txt，方案B唯一真相源；gitignore）
├── medical-raw-txt/             # 由原始文档归一化抽取的纯文本（供 outline 复用；gitignore）
├── medical-knowlegde-base/      # 检索索引（.outline/.guide-index/.knowledge-graph），由原始文档派生
├── .pi/
│   ├── cache/                   # 文件化检索缓存（.retrieval-cache.json）
│   └── extensions/              # 自定义扩展（检索增强 + Provider）
│       ├── lib/                 # 共享纯函数模块（jiti / 原生 node 通用）
│       │   ├── guide-router.mjs # 指南语义路由（IDF 加权 + 同义词归一）
│       │   ├── kg-search.mjs    # 知识图谱检索
│       │   ├── retrieval-cache.mjs # 文件化共享检索缓存
│       │   └── phi-crypto.mjs   # PHI 加密 + PII 脱敏 + 审计
│       ├── guide-finder.ts      # 指南路由工具（语义路由版）
│       ├── kg-search-tool.ts    # 知识图谱检索工具
│       ├── query-cache.ts       # 检索缓存管理命令（/cache）
│       ├── query-decomposer.ts  # 复杂问题分解
│       ├── answer-evaluator.ts  # 回答质量评估
│       ├── monitor-logger.ts    # 运行日志埋点 + 审计（/logs /audit）
│       ├── patient-profile.ts   # 患者画像（AES-256-GCM 加密 + 审计）
│       ├── agnes-provider.ts    # Agnes AI Provider
│       └── sensenova-provider.ts # 商汤日日新 Provider
├── prompts/
│   └── medical-agent.md         # 医疗 Agent System Prompt（核心定制）
├── scripts/
│   └── download-model.bat       # 嵌入模型预下载脚本
├── tests/
│   ├── test-cases.md            # 三类测试用例
│   ├── eval-bench.mjs           # 端到端评测基准（路由召回 / 延迟）
│   ├── eval-report.json         # 评测结果（结构化）
│   └── eval-report.html         # 评测结果（可视化）
├── start.example.bat            # 启动脚本模板（填入 Key 后复制为 start.bat）
├── README.md
```

## 技术栈

| 组件       | 技术                         | 说明                          |
| ---------- | ---------------------------- | ----------------------------- |
| Agent 框架 | Pi Agent (v0.80.3)           | ReAct 智能体循环 + 工具系统   |
| RAG 引擎   | pi-knowledge (v0.5.1)        | 本地优先，混合检索 + 重排序   |
| LLM        | DeepSeek V4 Flash            | `api.deepseek.com`            |
| 嵌入模型   | multilingual-e5-small (本地) | 约 32MB ONNX，零 API Key      |
| 向量存储   | pi-knowledge 内置向量文件    | 本地存储于 `~/.pi/knowledge/` |
| 运行环境   | Node.js 22.22.2+             | 满足 Pi 要求（>=22.19.0）     |

## 快速启动

### 方式一：双击 start.bat（推荐）

```bash
# 直接双击 start.bat 即可启动
```

### 方式二：命令行

```bash
# 设置 API Key
set DEEPSEEK_API_KEY=YOUR_DEEPSEEK_API_KEY_HERE

# 启动 Pi（含医疗 System Prompt）
node pi\packages\coding-agent\dist\cli.js ^
  --model deepseek/deepseek-v4-flash ^
  --system-prompt prompts\medical-agent.md
```

### 首次使用：索引知识库

在 Pi 交互界面中输入：

```
knowledge_plan { source: "medical-raw" }
knowledge_add { source: "medical-raw", name: "医疗指南" }
knowledge_show
```

### 开始提问

```
"原发性肝癌的高危人群有哪些？"
"儿童支原体肺炎的推荐用药是什么？"
"比较肝癌和胰腺癌的治疗方案差异"
```

## 常用命令（npm scripts）

项目以 `package.json` 提供逻辑分组的统一命令入口（物理文件仍平铺于 `scripts/` 与 `tests/`，避免破坏启动链路与测试引用）：

- **知识库**：`npm run kb:rebuild`（重建向量库）· `npm run kb:update`（源更新 CLI）· `npm run kb:prepare`（归一化原始文档）· `npm run kb:outline` / `npm run kb:index`（大纲 / 关键词索引）· `npm run kb:ingest`（单份入库）· `npm run kb:deprecate` / `npm run kb:lifecycle`（版本废止 / 数据生命周期）
- **代理与故障转移**：`npm run proxy:start`（本地 LLM 代理网关）· `npm run proxy:keys`（校验 sensenova key）· `npm run failover`（探测健康 Provider 并写 failover 选择）
- **测试**：`npm test`（全量数据完整性套件 `tests/run-all-tests.mjs`）· `npm run test:ci`（CI 门禁 `tests/eval-ci-gate.mjs`）
- **合规审计**：`npm run audit:verify`（校验审计链）

> 完整启动（含故障转移编排 + 代理网关 + Pi Agent）请用 `start.sh` / `start.bat` / `start.ps1`，勿单独以 `npm run` 启 Agent。

## 搜索模式速查

| 场景               |    模式    | 示例                                                   |
| ------------------ | :--------: | ------------------------------------------------------ |
| 常规问答           |  `hybrid`  | `knowledge_search({ query: "...", mode: "hybrid" })`   |
| 高精度（用药剂量） |   `deep`   | `knowledge_search({ query: "...", mode: "deep" })`     |
| 多指南对比         | `adaptive` | `knowledge_search({ query: "...", mode: "adaptive" })` |
| 精确术语           |   `fast`   | `knowledge_search({ query: "...", mode: "fast" })`     |
| 概念搜索           | `semantic` | `knowledge_search({ query: "...", mode: "semantic" })` |

## 扩展包（组合优先）

系统能力由**现成 Pi 生态包 + 极简手写胶水**构成，不重复造轮子。已安装并运行时加载：

- **pi-knowledge** — RAG 引擎（知识库索引 + 混合检索 + 交叉编码器重排序），`knowledge_search` 工具
- **pi-web-access** — 联网检索/网页理解，`web_search` / `fetch_content` 工具（P3：抓取最新指南）
- **pi-subagents** — 多代理并行/委派/分解，`subagent` 工具（P3：多指南对比诊疗）
- **@firstpick/pi-package-webui** — 本地浏览器 Web 端，会话内 `/webui-start` 启动（默认 127.0.0.1:31415）

> 注：**pi-mcp-adapter 刻意不装**——原规划接 Neo4j/Qdrant 后端，经核查两库从未运行（无 env、launch 不 compose up），纯增依赖无收益；`kg_search` 走本地 `.knowledge-graph.json`，跨文档检索由 pi-knowledge 原生 `knowledge_search` 覆盖。

如需 Web 端，启动 Pi 后在会话内执行 `/webui-start`，浏览器打开 http://127.0.0.1:31415/ 即可。

## 检索增强（近期）

针对「缓存孤岛、无语义路由、指标未量化」三项短板，已落地：

1. **文件化共享检索缓存** (`.pi/extensions/lib/retrieval-cache.mjs`)
   内存热层 + JSON 文件持久层，供 `guide_finder` / `kg_search` / `query-cache` 共用。
   重复查询热路径延迟由 ~4.5ms（冷）降至 **~0.05ms**（提速约 70×），`/cache` 命令可观测与清空。
2. **指南语义路由** (`.pi/extensions/lib/guide-router.mjs`)
   在关键词/标题字面匹配之上，新增 **IDF 加权词元重叠 + 主体/次要词分层 + 通用词剔除 +
   短语同义词归一**（如「胃部恶性肿瘤」→「胃癌」）。语义路由 top1 召回率由 **58% → 100%**，
   越界查询精度 **100%**。每条命中附「命中依据」便于医疗审计。
3. **端到端评测基准** (`tests/eval-bench.mjs`)
   无需 API Key，原生 node 运行。量化路由召回（字面 top3 100% / top1 92.6%、语义 top1 100%）、
   越界精度、冷/热检索延迟与 p95，产出 `tests/eval-report.json` 与 `tests/eval-report.html`。

```bash
# 跑出当前基线指标
node tests/eval-bench.mjs
```

## 合规与可观测性（近期）

针对医疗红线「PHI 明文落盘、缺审计留痕、免责措辞虚假权威」三项风险，已落地：

1. **PHI 静态加密** (`.pi/extensions/lib/phi-crypto.mjs`)
   患者画像（年龄/过敏史/病史/用药）以 **AES-256-GCM** 认证加密后落盘，明文绝不驻留磁盘。
   密钥优先取环境变量 `PATIENT_DATA_KEY`（凭证零信任），缺失则自动生成 `.pi/.data-key`（已 gitignore、权限 600），
   零配置也密文存储。历史明文首次读取时**透明迁移**为密文；密文被篡改时解密抛错（GCM 认证）。
2. **PII 脱敏** —— 手机号 / 身份证 / 邮箱 / 结构化姓名脱敏工具，供日志埋点在写盘前调用；
   业务日志只记 `promptLength` 等结构化计数，**绝不记录 prompt 原文**，从源头杜绝 PII 入日志。
3. **合规审计留痕** —— 患者画像的每次写入 / 读取注入均记 `logs/audit-YYYY-MM-DD.ndjson`
   （只记动作与字段名，不记原值），与业务日志分离。`/audit` 命令查看今日审计，`/logs` 查看业务日志。
4. **System Prompt 合规化** (`prompts/medical-agent.md`)
   删除「三甲医院主任医师级别」虚假权威表述，重定位为**循证医学信息辅助工具**；
   强制每次回答附免责声明（非诊断、不替代医师、紧急拨 120）；不越界下诊断结论。
5. **显式错误捕获** —— 加解密 / 日志 / 审计的失败不再静默吞掉，改写 stderr 并记审计事件，
   避免可观测性断裂无人知晓。

```bash
# 合规基础设施单测（加密往返 / 旧明文迁移 / PII 脱敏 / 审计，24 项）
node tests/compliance-test.mjs
```

> ⚠️ 生产部署请务必通过 `PATIENT_DATA_KEY` 环境变量注入密钥并做密钥轮换管理；
> `.pi/.data-key` 自动生成密钥仅用于本地开发零配置场景。

## 知识库扩展（近期）

针对「无自动更新机制、偏科 ~70% 肿瘤+血液」短板，已落地**来源登记与更新管理**：

> **知识库源（方案 B：弃 MD 中间层）** —— 原始 PDF/DOCX（`medical-raw/`）为唯一真相源，不再经 Markdown 中转。
> 索引重建四步（原生 node，需 `pdftotext` 与 python-docx 桥）：
>
> ```bash
> node scripts/prepare-raw.mjs        # 复制原始文档进项目 + 生成归一化 medical-raw-txt/
> node scripts/extract-outline.mjs    # 由原始文本重建 .outline.json（中文层级正则）
> node scripts/build-guide-index.mjs  # 重建 .guide-index.json（语义路由/关键词）
> node scripts/_rebuild-registry.mjs  # 重建 kb-sources.json（真实 sha256 指纹 + 专科归类）
> ```
>
> 向量库 `~/.pi/knowledge/` 由 Pi 运行时 `knowledge_add { source: "medical-raw" }` 重建（见上「首次使用」）。
> 注意：原始目录中 `.doc` 老格式 Pi 原生无法摄取，由 `prepare-raw.mjs` 经 `antiword` 抽文本后落为 `medical-raw/<同名>.txt`（Pi 原生 TXT 摄取），无需 LibreOffice。

1. **来源登记表** (`kb-sources.json`)
   每项含 `id/名称/类型(local|web|feed)/地址/cadence/校验方式`。新增外部源只需追加一行，
   无需改代码——结构化解开「更新机制缺失」死结。   当前登记 **135 份本地指南**（原始 PDF/DOCX，方案 B 唯一真相源）。外部官网源（国家卫健委公告）
   需凭证/网络，默认 `ingest` 显式标记未实现，不假装完成。
2. **内容指纹 + 过期判定** (`.pi/extensions/lib/kb-sources.mjs`)
   `contentHash`（sha256）对 local 源求真实内容指纹；`isStale` 按 cadence 阈值标记「过期待查」，
   供 `/kb` 命令与定时刷新提醒。版本**快照 + 回滚**：刷新前自动快照，异常即回滚，registry 不处半更新态。
3. **更新 CLI** (`scripts/kb-update.mjs`)
   `list / status / check / snapshot / rollback / refresh` 六命令。refresh 走
   `快照→摄取→更新 lastChecked/hash→回写`，真实 local 指纹落地（已验证 27 份文件哈希）。
4. **偏科缓解路径**：外部源（官网/RAG 语料库/内部 PDF）登记即纳入管理，覆写 `ingest` 钩子接抓取管线即可扩面。

```bash
# 来源登记与过期概况
node scripts/kb-update.mjs status
# 执行刷新（摄取+回写，异常回滚）
node scripts/kb-update.mjs refresh
```

## 高可用增强（近期）

针对「Pi 运行时无 Provider 拦截钩子、无内置故障转移」约束，落地**启动编排 + 运行时可观测**两层闭环：

1. **启动编排故障转移** (`scripts/launch-with-failover.mjs` + `start.bat`/`start.ps1`)
   每次启动前 `selectProvider` 探测各 Provider（`/models` 端点 + 3s 超时 + API Key 缺失判不健康），
   选出健康者写入 `.pi/failover-selection.json`，由启动脚本读入 `--model`，**自动避开宕机 Provider**。
   显式设置 `LLM_PROVIDER` 时尊重用户选择，跳过探测。
2. **Provider 注册表** (`lib/provider-health.mjs`)：deepseek(主) → agnes → sensenova×2 四候选，含优先级。
   `selectProvider` 全不健康时降级回退 priority 最小者并标注 degraded（避免启动即崩，但明确告警）。
3. **运行时可观测** (`provider-failover.ts`)
   周期（5min）健康监控，健康态跃迁记 `logs/audit-*.ndjson`；`/failover` 命令展示健康排行与当前选定；
   `/kb` 命令展示来源过期概况。会话关闭清理定时器。
4. **deepseek 走内置，无需扩展**：`deepseek` 是 Pi 内置 Provider（`pi/packages/ai/src/providers/deepseek.ts`，随启动经 `loadBuiltInModels` 自动播种），
   其 `deepseek-v4-flash`/`deepseek-v4-pro` 模型与思考模式均由内置提供。故**不写** `deepseek-provider.ts` 扩展注册——
   强写会因同名 `registerProvider` 覆盖内置、丢失模型与思考能力（已验证：覆盖后 max-out 由 384K 跌至 65.5K、thinking 变 no）。
   `agnes`/`sensenova` 在 `pi/packages` 全仓零内置，才需扩展注册。故障转移表仅存 deepseek 的**探测元数据**（baseUrl+authEnv），不注册 Provider。

> 注：因 Pi 无运行时 Provider 劫持钩子，「实时会话内切换」需重启（重新走编排）；
> 若需零重启热切换，须将 Agent 包成服务层（含请求重试/熔断）——属后续可选战役。

## 组合优先架构（P1/P2/P3 终局）

经扩展生态审计（见 `docs/extension-audit-2026-07-10.html`），系统确立「尽量用现成成熟方案、只在真正需要时手写」的架构纪律，分三阶段落地：

- **P1 减负**：删 Kafka/Redis 队列等孤立死代码；`apply-reranker-patch.mjs` 加版本锁防升级静默失效。
- **P2 删死重**：删未接生产的 `neo4j-search`/`qdrant-search`/`cross-doc-search` 及整个未激活 `scripts/infra/` 七栈（redis/qdrant/postgres/kafka/neo4j/prometheus/nginx 从未 `compose up`）；`kg-search-tool.ts` 移除永不走到的 Neo4j 分支。保留 `query-decomposer`（医学启发式，与 pi-subagents 互补）与 `conversation-state`（Agent 侧槽位追踪，与 pi-interview 关注点不同）。
- **P3 拼装扩充**：联网抓取最新指南 → `pi-web-access`；多代理对比诊疗 → `pi-subagents`；Web 端服务 → `@firstpick/pi-package-webui`（`/webui-start`）；答案级评测/幻觉检测 → `answer-evaluator.ts` 轻量 LLM-judge 封装（免费模型优先，sensenova-6.7-flash-lite → deepseek-v4-flash 兜底）。

手写代码已压至最小：仅检索路由/缓存/PHI 加密/合规审计等**不可替代的胶水与医疗合规逻辑**为手写，其余一律组合现成包。

## 设计原则

1. **零手写 RAG 代码** — RAG 能力完全由 pi-knowledge 提供
2. **本地优先** — 嵌入、向量、存储全部本地化，无需外部服务
3. **隐私友好** — API Key 仅用于 LLM 调用，知识库数据不出本地；PHI 静态加密、日志不记原文、读写留痕
4. **增量式可扩展** — 可随时加装 Pi 生态扩展包，无需改核心代码
