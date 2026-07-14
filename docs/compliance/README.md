# 医疗 Agentic RAG · 合规治理交付件

> 本目录为 **E 轨（合规治理）** 的正式交付件，刻意入仓（`.gitignore` 已放行 `docs/compliance/`），供审计、验收与第三方评估。
> 所有陈述均锚定代码事实，非凭空承诺。涉及的文件路径与行号以本仓库当前 HEAD 为准。

## 文档索引

| 文档 | 范围 | 核心结论 |
|---|---|---|
| [phi-handling.md](./phi-handling.md) | PHI 静态加密 + PII 脱敏 | AES-256-GCM 密文落盘，明文绝不驻留磁盘；输入 PII 经掩码后出境 |
| [guard-coverage.md](./guard-coverage.md) | 安全护栏覆盖矩阵 | 5 道护栏分层（越界/命令/忠实度/冲突/脱敏），代码层硬阻断 + 运行时真生效 |
| [retention-deletion.md](./retention-deletion.md) | 数据保留与删除策略 | 保留至被遗忘权行使；`forget_patient` 经覆写+删除安全擦除密文 |
| [third-party.md](./third-party.md) | 第三方处理者 | LLM 推理（sensenova 免费档）、本地嵌入（零外传）、KB 来源 |
| [user-rights.md](./user-rights.md) | 用户权利响应 | 被遗忘权已落地；访问/更正经既有机制；已知缺口透明披露 |
| [dpia.md](./dpia.md) | 数据保护影响评估（简化版） | 残余风险 LOW（含约束条件与缓释措施） |

## 合规基线速览

- **加密（静态）**：AES-256-GCM，认证加密防篡改。密钥零信任（环境变量 `PATIENT_DATA_KEY` 优先，缺失则本地 `.pi/.data-key` 自动生成并 `chmod 600`）。
- **审计（不可抵赖）**：HMAC-SHA256 防篡改哈希链（`audit-chain.mjs`），密钥 `AUDIT_HMAC_KEY` 或本地 `.pi/.audit-key`。仅记动作与字段名，**绝不记查询原文或 PHI 原值**。
- **护栏（运行时生效）**：越界请求 `scope-guard` 代码层注入 system 拒答；`bash-guard` 拦截危险命令+强制超时；`faithfulness-guard` 与 `conflict-detector` 经 `message_end` 真替换回答（E1 后生效，根治旧版「只观测不阻断」）。
- **数据红线（gitignore）**：`.pi/sessions/`（含对话 PHI）、`.pi/patient-profile.json`、`.pi/.data-key`、`.pi/.audit-key`、`.env`、`logs/`、`kb-sources.json` 均绝对不入仓。

## 与运行期代码的对应关系

| 合规能力 | 实现文件 |
|---|---|
| PHI 加密 / PII 脱敏 / 审计追加 | `.pi/extensions/lib/phi-crypto.mjs` |
| 审计哈希链（HMAC） | `.pi/extensions/lib/audit-chain.mjs` |
| 患者画像读写 / 被遗忘权 | `.pi/extensions/safety.patient-profile.ts` |
| 越界硬阻断 | `.pi/extensions/safety.scope-guard.ts` + `lib/scope-guard.mjs` |
| 命令护栏（P0） | `.pi/extensions/safety.bash-guard.ts` + `lib/bash-guard.mjs` |
| 忠实度 / 冲突 真阻断 | `.pi/extensions/safety.faithfulness-guard.ts` / `safety.conflict-detector.ts` |
| 输入脱敏入口 | `.pi/extensions/lib/query-sanitize.mjs` |

> 注：本目录为「治理证据」，代码改动本身见各 commit（E1/E2 等）。文档与代码冲突时，**以代码为准**。
