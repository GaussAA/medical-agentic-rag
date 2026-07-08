import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * 查询结果缓存扩展
 *
 * 在单次会话中缓存 knowledge_search 和 kg_search 的结果，
 * 相同查询可复用，减少重复 API 调用。
 *
 * 缓存策略: 会话级内存缓存，TTL 5 分钟
 */
export default function (pi: ExtensionAPI) {
  const CACHE_TTL_MS = 5 * 60 * 1000;

  // Simple string hash for cache keys
  function hash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) {
      h = ((h << 5) - h) + text.charCodeAt(i);
      h |= 0;
    }
    return String(h);
  }

  // In-memory cache store
  const store = new Map<string, { result: string; ts: number }>();

  // Periodically sweep stale entries
  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.ts > CACHE_TTL_MS) store.delete(key);
    }
  }, 60_000).unref();

  // Register /cache slash command
  pi.registerSlashCommand({
    name: "cache",
    description: "查看当前会话的查询缓存统计，或清空缓存",
  }, async (args) => {
    const cmd = (args || "").trim().toLowerCase();

    if (cmd === "clear") {
      store.clear();
      return { content: [{ type: "text", text: "缓存已清空。" }] };
    }

    const now = Date.now();
    let lines = [`查询缓存统计 (TTL: ${CACHE_TTL_MS / 1000}s)\n`];
    lines.push(`总条目: ${store.size}\n`);

    if (store.size > 0) {
      lines.push("最近条目:\n");
      const entries = Array.from(store.entries())
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, 10);

      for (const [key, entry] of entries) {
        const age = Math.round((now - entry.ts) / 1000);
        const preview = entry.result.slice(0, 60).replace(/\n/g, " ");
        lines.push(`  [${age}s ago] ${preview}...`);
      }
    }

    return { content: [{ type: "text", text: lines.join("\n") }] };
  });

  // Expose cache API for other extensions to use
  return {
    cacheGet(key: string): string | undefined {
      const entry = store.get(hash(key));
      if (entry && Date.now() - entry.ts < CACHE_TTL_MS) {
        return entry.result;
      }
      if (entry) store.delete(hash(key));
      return undefined;
    },
    cacheSet(key: string, result: string): void {
      store.set(hash(key), { result, ts: Date.now() });
    },
  };
}
