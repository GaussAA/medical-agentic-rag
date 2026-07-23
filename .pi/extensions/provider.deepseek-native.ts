import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * DeepSeek 原生 Provider 扩展
 *
 * 使用 Pi 内置的 deepseekProvider() 直连 api.deepseek.com，
 * 替代当前通过 sensenova 代理通道调用 deepseek 的方式。
 *
 * 优势：
 *   - 减少一层网络代理（sensenova 通道 → 直连）
 *   - 享受 Pi 内置的自动重试和健康检测
 *   - 支持 Pi 内置的 prompt caching
 *
 * 环境变量:
 *   DEEPSEEK_API_KEY — DeepSeek API key（必填）
 *   不配置时本 provider 自动跳过
 *
 * 模型:
 *   - deepseek-v4-flash  主力对话模型（免费额度有限）
 *   - deepseek-v4-pro    付费高精度模型
 */
export default function (pi: ExtensionAPI) {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    // 无 Key 时不注册，静默跳过
    return;
  }

  try {
    // Pi 内置的 deepseek provider 从 @earendil-works/pi-ai 导入
    // 但直接 import 可能因版本问题不可用，改用字符串注册
    pi.registerProvider("deepseek", {
      name: "DeepSeek (Native)",
      baseUrl: "https://api.deepseek.com",
      apiKey: "$DEEPSEEK_API_KEY",
      api: "openai-completions",
      models: [
        {
          id: "deepseek-v4-flash",
          name: "DeepSeek V4 Flash (Native)",
          api: "openai-completions",
          input: ["text"],
          contextWindow: 1_000_000,
          maxTokens: 65536,
          cost: {
            input: 0.3,      // $0.30/M tokens (estimate)
            output: 0.6,     // $0.60/M tokens
            cacheRead: 0.03, // $0.03/M tokens (cached input)
            cacheWrite: 0,
          },
        },
        {
          id: "deepseek-v4-pro",
          name: "DeepSeek V4 Pro (Native)",
          api: "openai-completions",
          input: ["text"],
          contextWindow: 64_000,
          maxTokens: 8192,
          cost: {
            input: 4,        // $4/M tokens
            output: 16,      // $16/M tokens
            cacheRead: 0.4,
            cacheWrite: 0,
          },
        },
      ],
    });
    console.log("[deepseek] Pi 原生 DeepSeek provider 已注册");
  } catch (e: any) {
    console.log("[deepseek] 注册失败（不影响现有 provider）:", e.message);
  }
}
