# 医疗 Agentic RAG 系统

基于 **Pi Agent (earendil-works/pi)** + **pi-knowledge** 构建的医疗知识问答系统。
知识源为 **26 份国家卫生健康委员会发布的权威诊疗指南**。

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
#   knowledge_plan { source: "medical-knowlegde-base" }
#   knowledge_add { source: "medical-knowlegde-base", name: "医疗指南" }
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
├── medical-knowlegde-base/      # 26 份医疗指南（Markdown）
├── .pi/
│   └── extensions/              # 自定义 LLM Provider 扩展
│       ├── agnes-provider.ts    # Agnes AI
│       └── sensenova-provider.ts # 商汤日日新
├── prompts/
│   └── medical-agent.md         # 医疗 Agent System Prompt（核心定制）
├── scripts/
│   └── download-model.bat       # 嵌入模型预下载脚本
├── tests/
│   └── test-cases.md            # 三类测试用例
├── start.example.bat            # 启动脚本模板（填入 Key 后复制为 start.bat）
├── README.md
```

## 技术栈

| 组件       | 技术                         | 说明                          |
| ---------- | ---------------------------- | ----------------------------- |
| Agent 框架 | Pi Agent (v0.80.3)           | ReAct 智能体循环 + 工具系统   |
| RAG 引擎   | pi-knowledge (v0.4.7)        | 本地优先，混合检索 + 重排序   |
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
knowledge_plan { source: "medical-knowlegde-base" }
knowledge_add { source: "medical-knowlegde-base", name: "医疗指南" }
knowledge_show
```

### 开始提问

```
"原发性肝癌的高危人群有哪些？"
"儿童支原体肺炎的推荐用药是什么？"
"比较肝癌和胰腺癌的治疗方案差异"
```

## 搜索模式速查

| 场景               |    模式    | 示例                                                   |
| ------------------ | :--------: | ------------------------------------------------------ |
| 常规问答           |  `hybrid`  | `knowledge_search({ query: "...", mode: "hybrid" })`   |
| 高精度（用药剂量） |   `deep`   | `knowledge_search({ query: "...", mode: "deep" })`     |
| 多指南对比         | `adaptive` | `knowledge_search({ query: "...", mode: "adaptive" })` |
| 精确术语           |   `fast`   | `knowledge_search({ query: "...", mode: "fast" })`     |
| 概念搜索           | `semantic` | `knowledge_search({ query: "...", mode: "semantic" })` |

## 扩展包

已安装：

- **pi-knowledge** — RAG 引擎（知识库索引 + 混合检索 + 交叉编码器重排序）

可选安装（按需）：

```bash
pi install npm:pi-web-access       # 联网搜索增强
pi install npm:pi-mcp-adapter      # MCP 服务集成
pi install npm:pi-subagents        # 并行子代理
```

## 设计原则

1. **零手写 RAG 代码** — RAG 能力完全由 pi-knowledge 提供
2. **本地优先** — 嵌入、向量、存储全部本地化，无需外部服务
3. **隐私友好** — API Key 仅用于 LLM 调用，知识库数据不出本地
4. **增量式可扩展** — 可随时加装 Pi 生态扩展包，无需改核心代码
