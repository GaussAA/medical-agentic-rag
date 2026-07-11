import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Agnes AI provider extension
 * 
 * API Endpoint: https://apihub.agnes-ai.com/v1
 * Model: agnes-2.0-flash
 * Auth: AGNES_API_KEY environment variable
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("agnes", {
    name: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    apiKey: "$AGNES_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "agnes-2.0-flash",
        name: "Agnes 2.0 Flash",
        api: "openai-completions",
        input: ["text"],
        contextWindow: 256_000, // Agnes 官方文档：2026年6月从 1M 回滚到 256K
        maxTokens: 65536, // Agnes API 限制最大 65536
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
