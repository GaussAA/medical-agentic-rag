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
    // 动态加载 pi-web-access 扩展
    const webAccess = require("pi-web-access");
    if (typeof webAccess.default === "function") {
      webAccess.default(pi);
      console.log("[web-access] pi-web-access 扩展已加载 (web_search + fetch_content)");
    }
  } catch (e: any) {
    // 静默降级：pi-web-access 不可用时不影响主流程
    console.log("[web-access] pi-web-access 未安装或加载失败，Web 搜索不可用");
  }
}
