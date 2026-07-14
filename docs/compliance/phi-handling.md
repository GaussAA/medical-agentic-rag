# PHI 处理规范（个人健康信息）

> 范围：本系统对患者 PHI（ demographics / 过敏史 / 既往病史 / 当前用药）与对话中 PII 的处理方式。
> 事实锚点：`.pi/extensions/lib/phi-crypto.mjs`、`.pi/extensions/safety.patient-profile.ts`、`.pi/extensions/lib/query-sanitize.mjs`。

## 1. PHI 静态加密（at rest）

| 项 | 实现 |
|---|---|
| 算法 | **AES-256-GCM**（认证加密，兼具保密性与完整性，防密文篡改） |
| 密钥来源 | 零信任：环境变量 `PATIENT_DATA_KEY` 优先；缺失则自动生成随机 32 字节密钥落 `.pi/.data-key`（已 gitignore，`chmod 600`），保证零配置亦密文落盘，**绝不退化为明文** |
| 密钥格式 | 支持 hex(64 位) 或 base64；长度非 32 字节即抛错（不静默用错密钥） |
| 落盘形态 | `encryptJSON` → 自描述密文串（`v1:gcm:<base64(iv|tag|cipher)>`），写 `.pi/patient-profile.json`（已 gitignore） |
| 明文驻留 | **明文绝不落盘**；内存中仅在加解密瞬时存在，无持久化 |

> 旧明文兼容：若读到历史明文 JSON，透明解析后回写为密文（`loadProfile` 内 `migrated` 分支），一次性迁移不留明文残留。

## 2. PII 脱敏（出境前）

`maskPII(text)` 对自由文本综合脱敏，**脱敏在写盘/出境前调用，原始 PHI 绝不进日志**：

| 类型 | 规则 | 示例 |
|---|---|---|
| 手机号 | 保留前 3 后 4，中间 `****` | `138****1234` |
| 身份证（18 位） | 保留前 6 后 4，中间 8 位 `********` | `340121********123X` |
| 邮箱 | 保留首字符与域名，用户名掩码 | `z***@example.com` |
| 结构化姓名 | 仅对已知「姓名」字段用 `maskName`（保留姓氏首字） | `张三→张*`、`欧阳娜娜→欧***` |

> 设计取舍（诚实披露）：**自由文本中的中文姓名不做脱敏**（中文姓名检测不可靠，易误伤医学实体）。仅结构化「姓名」字段经 `maskName` 处理。降低误伤与漏脱敏的权衡，已在护栏断言层以「防幻觉/PHI 维度」二次兜底（见 `guard-coverage.md`）。

## 3. 审计脱敏纪律

- `auditLog`（phi-crypto）仅记录**字段名与动作**（如 `patient_profile.write` + `fields:["allergies"]`），**绝不记字段原值**。
- `audit-chain`（HMAC 哈希链）同理：事件仅含动作 + 长度/计数元数据，不含查询原文或 PHI。
- 任何调用方写审计前须先脱敏；本层不代为脱敏敏感原文（仅兜底 stringify）。

## 4. 边界与残余风险

- **传输中（in transit）**：患者画像经 `on("context")` 注入对话上下文后，作为会话内容送往 LLM 推理提供方（sensenova）。该部分受 TLS 保护与「仅结构化最小字段」约束，但客观上 PHI 在推理会话中可见。缓释见 `third-party.md`。
- **密钥轮换**：当前密钥为单版本静态；未实现定期轮换接口。属已知缺口，建议后续补密钥版本化。
- **自由文本 PHI**：用户若在自由文本中键入未结构化识别的 PHI（如「我妈有糖尿病」），不会自动脱敏，依赖 `scope-guard` 不越界 + 用户自决。
