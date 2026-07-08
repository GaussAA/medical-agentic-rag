import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * SenseNova (日日新) provider extension - 商汤科技
 *
 * API Endpoint: https://token.sensenova.cn/v1
 * Auth: SENSENOVA_API_KEY environment variable
 *
 * 可用模型（共3个）:
 *   1. sensenova-6.7-flash-lite  ← 主力对话模型（256K ctx，免费1500次/5h）
 *   2. deepseek-v4-flash             ← DeepSeek 备用通道（1M ctx，免费500次/5h）
 *   3. sensenova-u1-fast             ← 信息图生成（非聊天模型，需独立端点）
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("sensenova", {
    name: "SenseNova",
    baseUrl: "https://token.sensenova.cn/v1",
    apiKey: "$SENSENOVA_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "sensenova-6.7-flash-lite",
        name: "SenseNova 6.7 Flash Lite",
        api: "openai-completions",
        input: ["text", "image"],
        contextWindow: 256_000,
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash (via SenseNova)",
        api: "openai-completions",
        input: ["text"],
        contextWindow: 1_000_000,
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
