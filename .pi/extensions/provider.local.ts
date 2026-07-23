import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Local LLM (LM Studio) provider extension
 *
 * 将本地运行的 LM Studio（或任何 OpenAI 兼容本地推理服务）
 * 注册为 Pi 的可选 Provider，使 /model 命令可见可切换。
 *
 * API Endpoint: http://localhost:1234/v1（LM Studio 默认端口）
 * Auth: 无需 API Key（设占位键通过 Pi 的 key 校验，LM Studio 不会验证它）
 *
 * 模型列表通过 refreshModels 动态从 LM Studio /v1/models 获取，
 * 同时保留一个静态后备供未联网时使用。
 *
 * context 说明：Gemma-4-E2B 原生 8K（8192），可在 LM Studio 界面手动上调
 * n_ctx 参数。已匹配用户设定值（32K）。其他模型同理。
 */
export default function (pi: ExtensionAPI) {
  pi.registerProvider("local", {
    name: "Local LLM (LM Studio)",
    baseUrl: "http://localhost:1234/v1",
    // Pi 的 openai-completions API 会校验 apiKey 非空（getClientApiKey），
    // 本地 LM Studio 不验证 Authorization，设占位字符串即可通过。
    apiKey: "local-no-auth",
    api: "openai-completions",
    models: [
      {
        id: "google/gemma-4-e2b",
        name: "Gemma-4-E2B (本地·静态后备)",
        api: "openai-completions",
        input: ["text"],
        // 已对齐 LM Studio 的 n_ctx 设定值（32K）。若在 LM Studio 中调整，
        // 同步更新此值以免 Pi 错误截断。
        contextWindow: 32768,
        maxTokens: 8192,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    ],
    async refreshModels({ signal }) {
      try {
        const res = await fetch("http://localhost:1234/v1/models", { signal });
        if (!res.ok) return;
        const { data } = await res.json();
        if (!Array.isArray(data) || data.length === 0) return;
        return data.map((m: { id: string }) => ({
          id: m.id,
          name: `${m.id} (本地)`,
          api: "openai-completions" as const,
          input: ["text"] as string[],
          // LM Studio /v1/models 不返回 context 信息，统一设为 32K。
          // 若加载不同模型，请在此调整对应值。
          contextWindow: 32768,
          maxTokens: 8192,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        }));
      } catch {
        // LM Studio 未运行——忽略，静态度量兜底
      }
    },
  });
}
