// scripts/ops/check-sensenova-keys.mjs
// 商汤日日新免费通道 · 多 Key 池健康巡检
//
// 用途：实测 SENSENOVA_API_KEYS 池中每枚 Key 的可用性，确认「最多 20 并发」额度可吃满。
// 安全性：仅输出 #序号 + valid/invalid + 简短错误，绝不回显任何 Key 明文。
// 并发：经 lib/llm-judge.mjs 的 checkKeyHealth 以 MAX_CONCURRENCY(20) 一次性并发 ping。

import { checkKeyHealth, availableKeyCount, SENSENOVA_CONCURRENCY } from "../../.pi/extensions/lib/llm-judge.mjs";

async function main() {
  const total = availableKeyCount();
  console.log("─".repeat(56));
  console.log("商汤日日新免费通道 · 多 Key 池健康巡检");
  console.log("─".repeat(56));
  console.log(`池内 Key 数 : ${total}`);
  console.log(`并发上限     : ${SENSENOVA_CONCURRENCY}（商汤免费额度封顶 20）`);
  console.log("─".repeat(56));

  if (total === 0) {
    console.log("⚠️ 未检测到任何 SENSENOVA_API_KEYS / SENSENOVA_API_KEY，请在 .env 配置。");
    console.log("─".repeat(56));
    process.exit(1);
  }

  const results = await checkKeyHealth();
  let ok = 0;
  for (const r of results) {
    if (r.ok) {
      ok++;
      console.log(`  #${String(r.index).padStart(2, "0")}  ✅ valid   · ${r.sample.replace(/\n/g, " ")}`);
    } else {
      console.log(`  #${String(r.index).padStart(2, "0")}  ❌ invalid · ${r.error}`);
    }
  }
  console.log("─".repeat(56));
  console.log(`可用 ${ok} / ${results.length}`);
  if (ok === 0) {
    console.log("⚠️ 全部 Key 不可用，请检查网络或 Key 有效性（注意：node fetch 不自动走 HTTPS_PROXY）。");
    process.exit(2);
  }
  if (ok < results.length) {
    console.log("⚠️ 部分 Key 失效，建议从 .env 的 SENSENOVA_API_KEYS 移除失效项。");
  }
  console.log("─".repeat(56));
}

main().catch((e) => {
  console.error("巡检异常:", e?.message || e);
  process.exit(3);
});
