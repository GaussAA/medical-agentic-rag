// kb-update.mjs
// 知识库源更新 CLI —— 知识库扩展战役的运维入口。
//
// 命令：
//   list              列出所有登记来源（id/名称/类型/cadence/上次检查）
//   status            展示过期情况（过期待查 vs 新鲜有效）
//   check             同 status 的详细版（逐项 stale/fresh 标记）
//   snapshot          快照当前 registry 到 .pi/kb-snapshots/，返回路径
//   rollback [path]  回滚 registry；省略 path 则用最新快照
//   refresh           刷新流程：快照→逐项 ingest→更新 lastChecked/hash→回写（异常回滚）
//
// 纯 node 运行，无外部依赖。用法：node scripts/kb-update.mjs <command> [args]

import { fileURLToPath, pathToFileURL } from "node:url";
import { join, dirname } from "node:path";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MOD = pathToFileURL(join(ROOT, ".pi/extensions/lib/kb-sources.mjs")).href;
const kb = await import(MOD);

const [cmd, arg] = process.argv.slice(2);

function fmtDate(s) {
  return s ? new Date(s).toISOString().slice(0, 10) : "从未";
}

async function main() {
  switch (cmd) {
    case "list": {
      const reg = kb.loadRegistry();
      if (reg.sources.length === 0) {
        console.log("（空）无登记来源，请创建 kb-sources.json 或参考 kb-sources.example.json");
        break;
      }
      console.log(`登记来源共 ${reg.sources.length} 项:\n`);
      for (const s of reg.sources) {
        console.log(
          `  [${s.id}] ${s.name}\n    类型=${s.type} cadence=${s.cadenceDays}天 上次检查=${fmtDate(s.lastChecked)} hash=${s.lastHash || "-"}`,
        );
      }
      break;
    }
    case "status":
    case "check": {
      const reg = kb.loadRegistry();
      const { stale, fresh } = kb.checkStaleness(reg);
      console.log(`来源 ${reg.sources.length} 项 → 过期待查 ${stale.length}，新鲜有效 ${fresh.length}\n`);
      for (const s of stale) {
        console.log(`  ✗ 过期待查: [${s.id}] ${s.name} (cadence ${s.cadenceDays}d, 上次 ${fmtDate(s.lastChecked)})`);
      }
      if (cmd === "check") {
        for (const s of fresh) {
          console.log(`  ✓ 新鲜: [${s.id}] ${s.name} (上次 ${fmtDate(s.lastChecked)})`);
        }
      }
      break;
    }
    case "snapshot": {
      const path = kb.snapshot();
      console.log(`已快照: ${path}`);
      break;
    }
    case "rollback": {
      let path = arg;
      if (!path) {
        const snaps = kb.listSnapshots();
        if (snaps.length === 0) {
          console.error("无可用快照");
          process.exit(1);
        }
        path = snaps[0];
      }
      const p = kb.rollback(path);
      console.log(`已回滚至: ${p}`);
      break;
    }
    case "refresh": {
      console.log("[kb] 执行刷新流程（快照→摄取→回写）…");
      const res = await kb.refreshAll();
      console.log(`\n结果: ${res.ok ? "✓ 全部成功" : "✗ 存在失败（已回滚）"}`);
      console.log(`快照: ${res.snapshot}`);
      if (res.rolledBack) console.log("⚠ 已回滚，registry 未处于半更新态");
      for (const r of res.results) {
        const mark = r.error ? "✗" : r.ingested ? "✓" : "·";
        console.log(`  ${mark} [${r.source}] ${r.reason || ""}`);
      }
      if (res.error) console.error(`错误: ${res.error}`);
      process.exit(res.ok ? 0 : 1);
      break;
    }
    default:
      console.log(`知识库更新 CLI

用法: node scripts/kb-update.mjs <command> [args]

命令:
  list              列出登记来源
  status            展示过期概况
  check             逐项展示 stale/fresh
  snapshot          快照 registry
  rollback [path]   回滚（省略 path 用最新快照）
  refresh           刷新流程（摄取+回写，异常回滚）`);
      process.exit(cmd ? 1 : 0);
  }
}

main().catch((err) => {
  console.error("[kb-update] 失败:", err);
  process.exit(1);
});
