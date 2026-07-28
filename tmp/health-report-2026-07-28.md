# 午间运维巡检 · 2026-07-28（周二）

---

## 1️⃣ 测试套件（56 suites）

**结果：55/56 通过，1 项挂起**

| 套件 | 结果 | 说明 |
|------|------|------|
| suites 1-16 | ✅ 全部通过 | 安全护栏/合规/评估/检索/Provider 注册等单测全绿 |
| **suite 17** — execute-contract.test.mjs | ⚠️ 挂起 | Node.js ESM top-level await + LLM API http 句柄残留导致子进程不退出，test-aggregate 卡死在 `await run()`。独立运行该套件 9/9 通过（257ms）。 |
| suites 18-56 | ✅ 全部通过 | kg-graph/retrieval-router/fts/cache/conflict-detector/engine/observability 等 39 套件全绿 |
| 端到端质量门禁 (suite 55) | ✅ PASS | 10项HARD全过：禁戒0违例、安全1.0、临床0.983、相关1.0、引用召回100%、忠实0低幻觉 |
| 真库冒烟 (suite 56) | ✅ PASS | 24/24 通过，5325 chunks / 349 files |

**建议**：suite 17 问题为已知 `retrieval.orchestrator.ts` 执行后 LLM API 句柄未释放所致。若短期内修复，可在 execute-contract.test.mjs 末尾加 `process.exit(0)` 强制退出，不等事件循环自然终止。

---

## 2️⃣ 看门狗扫描

**结果：✅ 正常**

- 扫描目录：`data/raw`
- 可摄取文件：151 个
- 新增指南：**0**
- 版本更新：**0**

无需处理。

---

## 3️⃣ 日志轮转

**结果：✅ 跳过（无超 14 天文件）**

- `.pi/logs/` 共有 36 个 ndjson 文件
- 最旧文件：2026-07-13（距今 15 天）
- `find -mtime +14` 返回空——所有文件修改时间均在 14 天窗口内
- 无需归档

---

## 4️⃣ 磁盘用量

**结果：✅ 正常，低于 5GB 告警线**

| 目录 | 用量 | 告警线 | 状态 |
|------|------|--------|------|
| `.pi/` 合计 | ~1.6 GB | 5 GB | ✅ |
| ├── models/ (bge-reranker-base 1.1G + multilingual-e5-small 465M) | 1.6 GB | — | — |
| ├── knowledge.db | 85 MB | — | — |
| ├── vectors/ | 7.9 MB | — | — |
| ├── logs/ | 3.1 MB | — | — |
| └── sessions/ | 788 KB | — | — |
| `.llm-wiki/` | 28 MB | 5 GB | ✅ |
| `retrieval-fts.db` | 80 MB | — | — |

**告警线 5GB，当前 ~1.66 GB，健康。**

---

## 5️⃣ 知识库统计

### Knowledge DB
| 指标 | 值 |
|------|----|
| Chunks | 5,325 |
| Files | 349 |
| Knowledge Bases | 1（"医疗指南"） |
| DB 大小 | 85 MB |
| 嵌入向量文件 | 2 个（7.9 MB） |
| Schema 版本 | 5 |

### LLM Wiki
| 类别 | 数量 |
|------|------|
| 实体 (entities) | 454 |
| 概念 (concepts) | 308 |
| 来源 (sources) | 63 |
| 分析 (analyses) | 37 |
| 综合 (syntheses) | 0 |
| 需求 (requirements) | 0 |
| **Wiki 页面合计** | **862** |
| 原始源文件 | 143 |
| Wiki 文件总数 | 1,050 |

### 待摄入池
| 目录 | 文件数 |
|------|--------|
| `data/raw-txt/` | 243 个 .txt 待选 |

---

## 📋 综合结论

```
┌─────────────────────────────────────────────────────┐
│  午间巡检 · 2026-07-28 15:41                       │
├─────────────────────────────────────────────────────┤
│  ✅ 测试套件    55/56 通过（1 项挂起非质量缺陷）   │
│  ✅ 看门狗扫描  无新增文件                          │
│  ✅ 日志轮转    无需归档                            │
│  ✅ 磁盘用量    1.66 GB / 5 GB，健康                │
│  ✅ 知识库快照  5325 chunks · 862 wiki 页           │
│  ⚠️ 建议修复    execute-contract.test.mjs 进程退出   │
└─────────────────────────────────────────────────────┘
```
