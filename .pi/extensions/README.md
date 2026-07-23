# `.pi/extensions/` 扩展索引

> 本目录是医疗 Agentic RAG 的 Pi 自定义扩展层。共 **20 个 .ts 扩展，100% 测试覆盖**。

## 命名约定

- **平铺发现**：平铺于 `.pi/extensions/*.ts`，由 Pi 框架 `*.ts` 通配自动加载。
- **文件名前缀分组**：`<group>.<basename>.ts`，`group ∈ { provider, retrieval, safety, eval, state }`。
- **共享库抽离**：纯函数复用模块置于 `lib/` 并已按职责拆分子目录。
- **扩展间零互引**：扩展互不 import 对方，通过工具名协作。

## 完整清单

### `provider`（LLM 提供商注册）

| 文件 | 职责 |
|------|------|
| `provider.sensenova.ts` | 商汤日日新（免费主力，256K context） |
| `provider.agnes.ts` | Agnes AI（兜底付费） |
| `provider.local.ts` | LM Studio 本地模型（localhost:1234，可选切换） |
| `provider.failover.ts` | 运行时故障转移 + `/failover` `/kb` 命令 |
| `provider.query-cache.ts` | 查询缓存管理 `/cache` 命令 |
| `provider.web-access.ts` | Web 搜索桥接（加载 pi-web-access 社区插件） |
| `provider.deepseek-native.ts` | Pi 原生 DeepSeek 直连（替代 sensenova 代理通道） |

### `retrieval`（检索 / 知识库）

| 文件 | 职责 | 注册工具 |
|------|------|---------|
| ~~`retrieval.guide-finder.ts`~~ | ❌ 已删除，被 orchestrator 取代 |
| ~~`retrieval.rag-search.ts`~~ | ❌ 已删除，被 orchestrator 取代 |
| ~~`retrieval.kg-search-tool.ts`~~ | ❌ 已删除，被 orchestrator 取代 |
| `retrieval.query-decomposer.ts` | 复杂问题分解（调用 query-transform） | `decompose_query` |
| `retrieval.medical-infographic.ts` | 医疗信息图生成（sensenova u1-fast） | `generate_infographic` |
| `retrieval.orchestrator.ts` | **统一检索入口**（retrieve，替代上述三个已废弃工具） | `retrieve` |

### `safety`（安全合规）

| 文件 | 职责 |
|------|------|
| `safety.scope-guard.ts` | 越界拦截（医疗领域边界，占卜/法律等拒答） |
| `safety.faithfulness-guard.ts` | 忠实度护栏（LLM-Judge fail-closed，HARD 默认开） |
| ~~`safety.bash-guard.ts`~~ | ❌ 已删除，由 @aliou/pi-guardrails 替代 |
| `safety.patient-profile.ts` | 患者画像（AES-256-GCM 加密 + 审计 + 被遗忘权） |
| `safety.audit-logger.ts` | 运行时审计日志埋点 |
| `safety.conflict-detector.ts` | 多指南冲突检测（检索期版本比较标注） |

### `eval`（评测 / 观测）

| 文件 | 职责 |
|------|------|
| `eval.answer-evaluator.ts` | 答案质量评估（免费模型优先 LLM-Judge） |
| `eval.monitor-logger.ts` | 运行日志埋点 + 会话自动归档 |

### `state`（会话状态）

| 文件 | 职责 |
|------|------|
| `state.conversation-state.ts` | 对话上下文（槽位追踪、澄清计数、越界护栏） |

## 共享库 `lib/` 模块索引

| 子目录 | 子模块 | 职责 |
|--------|--------|------|
| `retrieval-router/` | `db` / `matcher` / `fts` / `bm25` / `fusion` | BM25+FTS+RFF 检索管线 |
| `phi-crypto/` | `crypto` / `mask` / `audit` | AES-256-GCM 加密、PII 脱敏、审计哈希链 |
| `llm-judge/` | `client` / `judge` | 免费优先 LLM 客户端、四维答案质量评审 |
| `guide-router/` | `vocab` / `text` / `index` / `route` | 医疗词典、文本处理、索引加载、路由主逻辑 |
| `feedback-loop/` | `signal` / `aggregate` / `queue` / `merge` | 反馈信号采集、热点聚合、队列管理、gold 合并 |

## Pi 加载约束（重要）

经 `pi/packages/coding-agent/src/core/extensions/loader.ts` 确证：
1. 仅认 `.pi/extensions/*.ts`（平铺）与 `.pi/extensions/*/index.ts`（子目录包）。
2. 子目录内非 `index.ts` 会被静默忽略。
3. 不递归超过一层。

故本项目采用**平铺 + 文件名前缀分组**，不拆子目录。
