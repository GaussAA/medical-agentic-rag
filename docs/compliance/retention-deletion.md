# 数据保留与删除策略

> 范围：本系统各数据类的生命周期、保留期与删除/擦除机制。事实锚点：`.pi/extensions/lib/phi-crypto.mjs`（`secureWipeFile`）、`safety.patient-profile.ts`（`forget_patient`）、`.gitignore`。

## 1. 数据类目与保留期

| 数据类 | 落点 | 保留期 | 删除机制 |
|---|---|---|---|
| 患者画像（PHI 密文） | `.pi/patient-profile.json`（gitignore） | **保留至用户行使被遗忘权或系统弃用**（无固定过期） | `forget_patient` → `secureWipeFile` 覆写+删除 |
| 会话历史（可能含 PHI 对话） | `.pi/sessions/`（gitignore） | 运行期；随会话结束不再活跃 | 不入仓；本地按会话清理 |
| PHI 加密密钥 | `.pi/.data-key`（gitignore, chmod 600） | 与画像共生命周期 | 随画像擦除后失活（密文不可解） |
| 审计 HMAC 密钥 | `.pi/.audit-key`（gitignore） | 审计链生命期 | 本地 |
| 审计日志（动作/字段名） | `.pi/logs/audit-*.ndjson`（gitignore） | 按日切分，保留供合规追溯 | 运维按策略清理 |
| 业务/诊断日志 | `.pi/logs/` / `logs/`（gitignore） | 运行期 | 不入仓 |
| 知识库来源登记 | `kb-sources.json`（gitignore） | 与 KB 同生命周期 | 不入仓 |
| 原始文档（真相源） | `data/raw/`、`data/raw-txt/`（gitignore） | 摄取后保留备查 | 不入仓，可经管线重建 |
| 密钥配置 | `.env`（gitignore） | — | 绝不入库 |

> 设计原则：**含 PHI 或密钥的产物一律 gitignore**，仓库仅持「可重建的派生索引」（`data/kb/` JSON）与「运行期代码」，从根上杜绝敏感数据入库泄露。

## 2. 被遗忘权（Right to Erasure）—— 已落地

`forget_patient` 工具（E2 闭环）实现 GDPR 类被遗忘权：

1. **确认门**：须显式 `confirm=true` 方执行擦除，防误触发；否则中止并留痕（`patient_profile.forget_denied`）。
2. **安全擦除**：调用 `secureWipeFile` —— 对密文文件**覆写随机字节 N 次（默认 3）后 `unlink`**，避免密文/明文残留可被恢复。
3. **幂等**：文件已不存在即视为已擦除（重试/并发安全）。
4. **审计**：仅记 `patient_profile.forget`（动作 + `wiped:true`），**不记 PHI 原值**。
5. **副作用自然停止**：擦除后 `on("context")` 加载空画像，不再注入患者上下文。

> 单测固化：`tests/unit/patient-forget-test.mjs`（11 用例）——confirm=false 不动文件 / confirm=true 消失 / 幂等 / context 停止 / 审计零 PHI。

## 3. 密钥与残留

- 擦除画像后，`.pi/.data-key` 仍存在（仅失活，对应密文已不可解）。如需彻底弃用，运维可单独清理密钥文件——此操作不可逆（历史密文永久不可恢复），故不自动执行，留作显式运维动作。
- 审计日志本身不含 PHI 原值，保留不泄露个人健康信息，符合追溯与隐私的平衡。

## 4. 已知缺口

- **无自动过期（TTL）**：当前仅「按需擦除」，未实现固定保留期后的自动销毁。若合规要求「N 天后自动清除」，需补 `retention-sweep` 定时任务。
- **审计日志保留期未设上限**：当前按日无限留存，建议补运维清理策略（如保留 180 天）。
