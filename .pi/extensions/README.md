# `.pi/extensions/` 扩展索引

> 本目录是医疗 Agentic RAG 的 Pi 自定义扩展层。本文件为分类索引与维护约定，非 Pi 框架文件。

## 命名约定

- **平铺发现**：所有入口扩展平铺于 `.pi/extensions/*.ts`，由 Pi 框架 `*.ts` 平铺发现模式自动加载。
- **文件名前缀分组**：`<group>.<basename>.ts`，`group ∈ { retrieval, provider, safety, eval, state }`。
  - 前缀仅作分组标识（IDE 自动折叠、人眼一眼归类），**不改变加载行为**。
- **共享库抽离**：纯函数复用模块置于 `lib/*.mjs`，被多个扩展引用；同一份逻辑既能被 jiti（扩展内）加载，也能被原生 node 单测，避免逻辑分叉。
- **扩展间零互引**：扩展互不 `import` 对方文件，仅通过 System Prompt 工具名协作；工具注册名（`registerTool` 的 `name`）独立于文件名。

## 分组清单

### `retrieval`（检索 / 知识库）

| 文件                            | 职责                               | 注册工具          | 依赖 lib           |
| ------------------------------- | ---------------------------------- | ----------------- | ------------------ |
| `retrieval.guide-finder.ts`     | 指南路由（语义路由定位应查指南）   | `guide_finder`    | `guide-router`     |
| `retrieval.kg-search-tool.ts`   | 知识图谱检索                       | `kg_search`       | `kg-search`        |
| `retrieval.rag-search.ts`       | 定向召回（语义路由约束 + 真 hybrid：BM25 回退 / dense 委托 KnowledgeEngine + bge 重排） | `rag_search` | `retrieval-router`,`knowledge-engine-search` |
| `retrieval.query-decomposer.ts` | 复杂问题分解为子查询               | `decompose_query` | （启发式，无 lib） |

### `provider`（Provider 与高可用）

| 文件                      | 职责                                     | 注册工具 / 注      | 依赖 lib                                      |
| ------------------------- | ---------------------------------------- | ------------------ | --------------------------------------------- |
| `provider.agnes.ts`       | Agnes AI Provider 注册                   | `registerProvider` | —                                             |
| `provider.sensenova.ts`   | 商汤日日新 Provider（免费通道）          | `registerProvider` | —                                             |
| `provider.failover.ts`    | 运行时故障转移（`/failover` `/kb` 命令） | 命令               | `provider-health`, `kb-sources`, `phi-crypto` |
| `provider.query-cache.ts` | 查询缓存管理（`/cache` 命令）            | 命令               | `retrieval-cache`                             |

### `safety`（安全合规）

| 文件                        | 职责                                      | 注册工具           | 依赖 lib                   |
| --------------------------- | ----------------------------------------- | ------------------ | -------------------------- |
| `safety.bash-guard.ts`      | bash 护栏（超时+命令拦截，覆盖内置 bash） | 覆盖 `bash`        | `bash-guard`, `phi-crypto` |
| `safety.patient-profile.ts` | 患者画像（AES-256-GCM 加密 + 审计）       | `remember_patient` | `phi-crypto`               |

### `eval`（评测 / 观测）

| 文件                       | 职责                                    | 注册工具 | 依赖 lib     |
| -------------------------- | --------------------------------------- | -------- | ------------ |
| `eval.answer-evaluator.ts` | 答案质量评估（`/eval`，免费模型优先）   | 命令     | `llm-judge`  |
| `eval.monitor-logger.ts`   | 运行日志埋点 + 审计（`/logs` `/audit`） | 命令     | `phi-crypto` |

### `state`（会话状态）

| 文件                          | 职责             | 注册工具                    | 依赖 lib    |
| ----------------------------- | ---------------- | --------------------------- | ----------- |
| `state.conversation-state.ts` | 会话状态槽位追踪 | `update_conversation_state` | （node:fs） |

## Pi 加载约束（重要，勿违）

经 `pi/packages/coding-agent/src/core/extensions/loader.ts` 确证：

1. **仅认两种形态**：`.pi/extensions/*.ts`（平铺）与 `.pi/extensions/*/index.ts`（子目录包）。
2. **子目录内非 `index.ts` 会被静默忽略**——扩展直接丢失，无报错。
3. **不递归超过一层**。

故本项目**采用「平铺 + 文件名前缀分组」，不拆子目录**：

- 平铺 → loader 零风险、新增扩展零改动（丢文件即生效）。
- 前缀命名 → 视觉分组、IDE 折叠，规避「纯平铺随扩展增长而乱」与「子目录致目录爆炸 / 单文件巨型化」两难。
- 若未来扩展数过百，优先改用「前缀命名 + 本索引」检索，而非物理子目录。
