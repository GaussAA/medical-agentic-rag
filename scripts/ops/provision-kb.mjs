// scripts/ops/provision-kb.mjs
// 知识库供给（T15 多活）：为每个 Pod 准备「独立可写 KB 副本」。
//
// 两种模式：
//   --src-dir <dir> --target-dir <dir>   拷贝模式：从共享 KB 源（RWX PVC）拷贝到本 Pod 的
//                                         可写 emptyDir（确保 Pi 独占 WAL 写锁，根除多实例崩溃）。
//   --build --target-dir <dir>           构建模式：运行 `npm run kb:rebuild` 把 KB 构建进目标目录
//                                         （供 kb-build-job 一次性写入共享 PVC）。
//
// 退出码：0=成功；非0=失败（initContainer / Job 将据此判定）。绝不静默吞错。

import { existsSync, cpSync, mkdirSync, statSync, readdirSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { spawn } from "node:child_process";

function parseArgs(argv) {
  const out = { srcDir: null, targetDir: null, build: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--build") out.build = true;
    else if (a === "--src-dir") out.srcDir = argv[++i];
    else if (a === "--target-dir") out.targetDir = argv[++i];
  }
  return out;
}

function fingerprint(dir) {
  if (!existsSync(dir)) return "missing";
  let total = 0;
  try {
    for (const f of readdirSync(dir)) {
      const st = statSync(join(dir, f));
      if (st.isFile()) total += st.size;
    }
  } catch { /* noop */ }
  return `${(total / 1024 / 1024).toFixed(1)}MB`;
}

function run(cmd, args, env) {
  return new Promise((resolveRun, rejectRun) => {
    const child = spawn(cmd, args, { stdio: "inherit", env: { ...process.env, ...env } });
    child.on("error", rejectRun);
    child.on("exit", (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`${cmd} 退出码 ${code}`))));
  });
}

async function main() {
  const { srcDir, targetDir, build } = parseArgs(process.argv.slice(2));
  if (!targetDir) throw new Error("缺少 --target-dir");
  const target = resolve(targetDir);

  if (build) {
    // 构建模式：设 HOME 使 Pi 把 KB 写到 target（target = $HOME/.pi/knowledge）
    const home = dirname(dirname(target)); // /home/pi/.pi/knowledge -> /home/pi
    mkdirSync(target, { recursive: true });
    console.log(`[provision-kb] 构建模式 → HOME=${home} target=${target}`);
    // 确保 better-sqlite3 对当前 node 可用（镜像应已构建，此处兜底重建一次）
    try {
      await run(process.execPath, ["node_modules/.bin/npm", "rebuild", "better-sqlite3"], { HOME: home });
    } catch (e) {
      console.warn(`[provision-kb][警告] better-sqlite3 重建失败（若镜像已构建可忽略）：${e.message}`);
    }
    console.log(`[provision-kb] 运行 kb:rebuild …`);
    await run(process.execPath, ["scripts/kb/rebuild-kb.mjs"], { HOME: home, PI_KNOWLEDGE_WATCH: "false" });
  } else if (srcDir) {
    // 拷贝模式：共享 KB 源 → 本 Pod 独立副本
    const src = resolve(srcDir);
    if (!existsSync(src)) throw new Error(`KB 源不存在: ${src}`);
    mkdirSync(target, { recursive: true });
    // 先清旧（确保幂等），再整体拷贝
    for (const f of readdirSync(target)) {
      try { rmSync(join(target, f), { recursive: true, force: true }); } catch { /* noop */ }
    }
    console.log(`[provision-kb] 拷贝模式 ${src} → ${target}`);
    cpSync(src, target, { recursive: true });
  } else {
    throw new Error("需指定 --build 或 --src-dir");
  }

  const dbPath = join(target, "knowledge.db");
  if (!existsSync(dbPath)) throw new Error(`构建/拷贝后未找到 knowledge.db: ${dbPath}`);
  const size = statSync(dbPath).size;
  if (size === 0) throw new Error(`knowledge.db 为空: ${dbPath}`);
  console.log(`[provision-kb] 完成。KB 指纹=${fingerprint(target)} knowledge.db=${size}B`);
}

main().then(
  () => process.exit(0),
  (err) => { console.error(`[provision-kb][错误] ${err.stack || err.message}`); process.exit(1); }
);
