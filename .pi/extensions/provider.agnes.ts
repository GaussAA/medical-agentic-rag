import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Agnes AI provider extension
 *
 * API Endpoint: https://apihub.agnes-ai.com/v1
 * 模型: agnes-2.0-flash（免费，1M 上下文/FC/Tool Use，RPM=20）
 * 注：agnes-2.5-flash 2026-07-13 发布但当前 Key（default group）返回 503 model_not_found，
 *     暂不可用，待官方开放后补回。
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
        contextWindow: 256_000,
        maxTokens: 65536,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
  });
}
