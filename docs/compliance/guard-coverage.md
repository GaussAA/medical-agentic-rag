# 安全护栏覆盖矩阵

> 范围：本系统运行期安全护栏的层次、机制与阻断力。事实锚点见各 `.pi/extensions/safety.*.ts` 与对应 `lib/*.mjs`。
> **关键事实（E1 闭环）**：faithfulness / conflict 两道护栏原仅「观测埋点、不替换消息」（G1 缺陷），经 E1 改造后已**经 `message_end` 钩子真替换最终回答**（`return { message }`），由 Pi 框架 `_replaceMessageInPlace` 同步状态与持久化——**观测升为阻断**。

## 覆盖矩阵

| # | 护栏 | 接入点 | 决策机制 | 阻断力 | 实现 |
|---|---|---|---|---|---|
| 1 | **scope-guard**（越界拒答） | `on("context")` 每轮 LLM 调用前 | 确定性（**零 LLM**）：医疗白名单 + 非医疗黑名单，保守放行 | **硬阻断**：越界时注入 system 拒答指令，LLM 不可绕过 | `safety.scope-guard.ts` + `lib/scope-guard.mjs` |
| 2 | **bash-guard**（P0 防卡死） | `registerTool("bash")` 覆盖内置同名工具 | 危险命令拦截（全盘 `find /`、系统目录递归等直接拒绝不启子进程）+ 超时夹紧（默认/上限） | **硬阻断**：拦截命令抛错拒绝；超时最坏被 kill，杜绝分钟级卡死 | `safety.bash-guard.ts` + `lib/bash-guard.mjs` |
| 3 | **faithfulness-guard**（生成可信度） | `on("message_end")` 回答定稿后 | 免费 LLM 四维评审（复用 `lib/llm-judge`，忠实/相关/临床/安全） | **E1 后真生效**：`block`→替换为纯护栏拦截文；`annotate`→原回答末尾附循证核验批注 | `safety.faithfulness-guard.ts` + `lib/faithfulness-guard.mjs` |
| 4 | **conflict-detector**（跨指南冲突） | `on("message_end")` 回答定稿后 | Layer1 版本冲突（零成本，guide-index 标记 deprecated/supersededBy）+ Layer2 跨指南内容冲突（免费 LLM） | **E1 后真生效**：`annotate`→原回答末尾附冲突批注 | `safety.conflict-detector.ts` + `lib/conflict-detector.mjs` |
| 5 | **query-sanitize**（输入脱敏） | 输入入口 | PII 掩码（手机/身份证/邮箱/结构化姓名） | 软（脱敏，不阻断问诊） | `lib/query-sanitize.mjs` |

## 阻断力分级说明

- **代码层硬阻断（#1/#2）**：在 LLM 可决策之前由代码确定性判定，LLM 无法忽略（弥补纯 System Prompt 软约束被模型跳过的不足）。
- **运行时真阻断（#3/#4）**：评审在回答定稿后、回传前端前发生；`block`/`annotate` 经 `buildReplacementMessage` 转为 `message_end` 替换消息，**真落地**而非仅埋点。
- **软处理（#5）**：输入脱敏为防御纵深一环，不阻断合法问诊。

## 验证契约（单测固化）

| 护栏 | 单测 | 固化契约 |
|---|---|---|
| faithfulness / conflict 真替换 | `tests/unit/guard-replacement-test.mjs`（19 用例） | block→拦截文 / annotate→原回答+批注 / pass|null→undefined / role 恒 assistant |
| scope-guard | `tests/unit/scope-guard-test.mjs` | 越界→拒答指令注入 / 不越界→放行 |
| bash-guard | `tests/unit/conflict-detector-test.mjs` 旁 | 危险命令→拦截 / 超时夹紧 |
| query-sanitize | `tests/unit/query-sanitize-test.mjs` | 手机/身份证/邮箱掩码正确 |

> 全部接入 `npm test` 主链，CI 门禁（`eval-ci-gate`）另以阈值卡「安全≥0.9 / 临床≥0.8 / 越界拒答 100% / 引用≥70% / 允许断言≥60%」等维度。

## 已知缺口（诚实披露）

- 自由文本中文姓名未做自动脱敏（误伤权衡，见 `phi-handling.md` §2）。
- 护栏评审为「免费 LLM」异步路径；评审超时/失败**放行**（不卡死用户），仅告警留痕——属可用性优先设计，非漏防。
