import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  const CACHE_TTL_MS = 5 * 60 * 1000;
  const store = new Map<string, { result: string; ts: number }>();

  function hash(text: string): string {
    let h = 0;
    for (let i = 0; i < text.length; i++) { h = ((h << 5) - h) + text.charCodeAt(i); h |= 0; }
    return String(h);
  }

  setInterval(() => {
    const now = Date.now();
    for (const [key, entry] of store) {
      if (now - entry.ts > CACHE_TTL_MS) store.delete(key);
    }
  }, 60_000).unref();

  pi.registerCommand("cache", {
    description: "Show or clear query cache (stats / clear)",
    handler: async (args: string, ctx: any) => {
      const cmd = (args || "").trim().toLowerCase();
      if (cmd === "clear") {
        store.clear();
        ctx.ui.notify("Cache cleared.", "info");
        return;
      }

      const now = Date.now();
      let output = `Cache entries: ${store.size}`;
      if (store.size > 0) {
        const entries = Array.from(store.entries())
          .sort((a, b) => b[1].ts - a[1].ts)
          .slice(0, 5);
        for (const [key, entry] of entries) {
          const age = Math.round((now - entry.ts) / 1000);
          const preview = entry.result.slice(0, 40).replace(/\n/g, " ");
          output += `\n  [${age}s ago] ${preview}...`;
        }
      }
      ctx.ui.notify(output, "info");
    },
  });

  return {
    cacheGet(key: string): string | undefined {
      const entry = store.get(hash(key));
      if (entry && Date.now() - entry.ts < CACHE_TTL_MS) return entry.result;
      if (entry) store.delete(hash(key));
      return undefined;
    },
    cacheSet(key: string, result: string): void {
      store.set(hash(key), { result, ts: Date.now() });
    },
  };
}
