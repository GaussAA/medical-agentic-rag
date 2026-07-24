import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * pi-web-access 桥接扩展
 *
 * 加载社区插件 pi-web-access v0.13.0，注册 web_search 和 fetch_content 工具。
 * 支持 Brave Search、Tavily、Exa、Perplexity、OpenAI Search 等多引擎。
 *
 * 环境变量（任一配置即可启用 web_search）：
 *   BRAVE_API_KEY        — Brave Search API key（推荐，免费额度 2000次/月）
 *   TAVILY_API_KEY       — Tavily Search API key
 *   EXA_API_KEY          — Exa Search API key
 *   PERPLEXITY_API_KEY   — Perplexity Search API key
 *   OPENAI_API_KEY       — OpenAI Search（需支持搜索的模型）
 */
export default function (pi: ExtensionAPI) {
  try {
    // 验证 pi-web-access 包在项目 .pi/npm/node_modules/ 中可加载
    (() => {
      // 1. 从项目 .pi/npm/node_modules/ 查找（项目级隔离安装，优先）
      const projectPath = require("node:path").join(
        process.cwd(), ".pi", "npm", "node_modules", "pi-web-access", "index.ts"
      );
      if (require("node:fs").existsSync(projectPath)) return projectPath;
      // 2. 从当前进程的模块路径查找（全局包残留兼容）
      try { return require.resolve("pi-web-access"); } catch {}
      throw new Error("not found");
    })();
    // 工具注册由全局 pi-web-access Pi 包自行完成，本桥接仅验证可抵达
    console.log("[web-access] pi-web-access 包可用 (工具由项目 Pi 包注册)");
  } catch (e: any) {
    // 静默降级：pi-web-access 不可用时不影响主流程
    console.log("[web-access] pi-web-access 未安装或加载失败，Web 搜索不可用");
  }
}
