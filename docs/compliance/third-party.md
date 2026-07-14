# 第三方处理者（Sub-processors）

> 范围：本系统将用户数据/查询送往的外部处理方，及其数据处理性质。事实锚点：`lib/llm-judge.mjs`、`.gitignore` KB 路径、`start.sh` provider-proxy 配置。
> 原则：凡涉及外部传输，均默认走**免费额度模型 + 环境变量凭证**，严禁硬编码密钥（零信任）。

## 1. LLM 推理提供方（sensenova / 商汤日日新）

| 项 | 说明 |
|---|---|
| 提供方 | 商汤 sensenova（`token.sensenova.cn` OpenAI 兼容端点） |
| 模型 | `sensenova-6.7-flash-lite`（每日免费额度主力）；回退 `sensenova/deepseek-v4-flash`；再回退原生 `deepseek-v4-flash`（付费，仅兜底） |
| 凭证 | `SENSENOVA_API_KEY` 环境变量（GitHub Secrets / 本地 `.env`，**绝不入库**） |
| 流出数据 | 用户查询 + 检索召回的指南上下文（用于 faithfulness / conflict 护栏评审、答案质量 Judge） |
| 传输保护 | HTTPS/TLS |
| 数据用途 | 仅实时推理，**不用于训练**（免费档条款默认） |

> 缓释：查询出境前经 `query-sanitize` 脱敏（手机/身份证/邮箱）；患者画像以**结构化最小字段**注入上下文（无自由文本叙述），降低 PHI 暴露面。但须诚实注明：推理会话中 PHI 客观上对提供方可见（见 `phi-handling.md` §4）。

## 2. 嵌入模型（本地，零外传）

| 项 | 说明 |
|---|---|
| 模型 | `multilingual-e5-small`（本地推理） |
| 外传 | **无**。嵌入在本地完成，文本/向量不出境 |
| 密钥 | 无 |

## 3. 知识库（KB）来源

| 项 | 说明 |
|---|---|
| 主来源 | 国家卫健委（NHC）公开临床指南直链（经 `nhc-medical-pdf-crawl` 同源质检入库） |
| 补充来源 | Europe PMC Open Access（OA 多源，覆盖 13 病种） |
| 原始文档存放 | `data/raw/`（411MB，**gitignore**，不入仓） |
| 真实库位置 | 用户 HOME 的 `~/.pi/knowledge/knowledge.db`（跨项目共享，`gitignore`） |
| 个人信息 | 来源均为公开官方指南，**不含患者 PHI** |

## 4. 处理者风险评估

| 处理者 | PHI 暴露 | 风险 | 缓释 |
|---|---|---|---|
| sensenova LLM | 查询 + 结构化画像上下文 | 中（推理会话可见） | TLS + 脱敏 + 最小字段 + 免费档不训练 |
| 本地嵌入 | 无 | 无 | — |
| NHC / Europe PMC | 无 PHI | 低 | 公开官方来源 |

## 5. 已知缺口

- **无 DPA（数据处理协议）归档**：当前依赖提供方公开条款，未与 sensenova 签书面 DPA。若进入生产化合规，须补签。
- **跨境传输**：sensenova 为国内服务，数据不出境；但若未来切境外模型，须重评跨境合规（如适用）。
