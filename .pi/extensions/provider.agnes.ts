import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Agnes AI provider extension
 *
 * API Endpoint: https://apihub.agnes-ai.com/v1
 * 可用模型（共2个，均免费）:
 *   1. agnes-2.5-flash ← 2026-07-13 新发布，Agent/Coding 优化，更强
 *   2. agnes-2.0-flash ← 原免费模型，1M 上下文/FC/Tool Use
 * Auth: AGNES_API_KEY environment variable
 * 免费用户 RPM=20，不适于高并发批量（sensenova 20 Key 池负责主力并发）
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("agnes", {
    name: "Agnes AI",
    baseUrl: "https://apihub.agnes-ai.com/v1",
    apiKey: "$AGNES_API_KEY",
    api: "openai-completions",
    models: [
      {
        id: "agnes-2.5-flash",
        name: "Agnes 2.5 Flash",
        api: "openai-completions",
        input: ["text"],
        contextWindow: 256_000, // 新版，与 2.0 同规格
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
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
