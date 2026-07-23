import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheStats, cacheClear } from "./lib/retrieval-cache.mjs";

/**
 * 检索缓存管理命令
 *
 * 实际的缓存读写由 guide_finder / kg_search 在检索时自动触发（经 ./lib/retrieval-cache.mjs
 * 文件化共享存储）。本扩展仅提供 /cache 命令用于观测与清空，与检索管线共用同一缓存。
 */
export default function (pi: ExtensionAPI) {
  pi.registerCommand("cache", {
    description: "查看或清空检索缓存（stats / clear）。缓存加速重复的 guide_finder 与 kg_search 查询。",
    handler: async (args: string, ctx: any) => {
      const cmd = (args || "").trim().toLowerCase();
      if (cmd === "clear") {
        cacheClear();
        ctx.ui.notify("检索缓存已清空。", "info");
        return;
      }

      const s = cacheStats();
      const output =
        `检索缓存:\n` +
        `  条目(有效/过期): ${s.valid}/${s.expired}\n` +
        `  文件: ${s.file}`;
      ctx.ui.notify(output, "info");
    },
  });
}
