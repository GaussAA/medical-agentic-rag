// launch-with-failover.mjs
// 启动编排：在拉起 Pi 前探测各 Provider 健康态，选出最优者写入 .pi/failover-selection.json，
// 供 start.bat / start.ps1 读取后注入 --model，实现「每次启动自动避开宕机 Provider」。
//
// 纯 node 运行（零依赖，用原生 fetch）。被 start 脚本以 `node scripts/launch-with-failover.mjs` 调用。
//
// 退出码：0 = 已选出（无论是否 degraded）；非 0 = 探测全失败且无法回退（理论上不会发生，selectProvider 总有回退）。

import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { selectProvider } from "../.pi/extensions/lib/provider-health.mjs";

const OUT = join(process.cwd(), ".pi", "failover-selection.json");

async function main() {
  console.log("[failover] 探测 Provider 健康态…");
  const sel = await selectProvider();
  mkdirSync(join(process.cwd(), ".pi"), { recursive: true });
  writeFileSync(
    OUT,
    JSON.stringify(
      {
        provider: sel.provider,
        model: sel.model,
        degraded: sel.degraded,
        label: sel.label,
        reason: sel.reason,
        ts: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf-8",
  );
  const flag = sel.degraded ? "⚠ 降级" : "✓ 健康";
  console.log(`[failover] 选定 ${sel.provider}/${sel.model} (${flag})`);
  if (sel.degraded) {
    console.error(`[failover][告警] ${sel.reason}`);
  }
  // 最后一行输出 provider/model，便于 start 脚本直接捕获（双保险，主用 json 文件）
  console.log(`${sel.provider}/${sel.model}`);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[failover] 选择失败:", err);
    process.exit(1);
  },
);
