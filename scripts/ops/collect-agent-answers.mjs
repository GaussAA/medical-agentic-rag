#!/usr/bin/env node
/**
 * collect-agent-answers.mjs
 * M2 端到端升级 · 真实 Agent 回答采集器
 * ----------------------------------------------------------------
 * 对 tests/gold-answers.json 中 systemAnswer 为 null 的条目，驱动 Pi Agent
 * （非交互 --print 模式）对问题作答，将真实输出回填 systemAnswer 字段，
 * 使 answer-quality-judge 从「黄金答案自验」升为「端到端答案可信度基线」。
 *
 * 设计要点（契合项目防御式工程规范）：
 *  - 内置极简 .env 加载（向上查找，不覆盖已注入环境变量）
 *  - 每条超时 280s 硬保护，避免悬挂（沙箱 TLS 代理下 AbortSignal 不可靠）
 *  - 原子写回（先写 .tmp 再 rename），中途失败不破坏原文件
 *  - stderr 单独捕获，记录 Extension error 等技术债供后续排查
 *  - ANSI 转义清洗，仅保留纯文本回答
 *
 * 用法：
 *   node scripts/ops/collect-agent-answers.mjs                 # 采全部 null 条目
 *   node scripts/ops/collect-agent-answers.mjs --dry-run       # 仅打印将执行的命令
 *   node scripts/ops/collect-agent-answers.mjs --only Q01      # 仅采指定 id（支持逗号分隔多 id，如 --only Q37,Q38）
 *   node scripts/ops/collect-agent-answers.mjs --limit 3       # 仅采前 3 条
 *   node scripts/ops/collect-agent-answers.mjs --force         # 覆盖已有 systemAnswer
 *   node scripts/ops/collect-agent-answers.mjs --model deepseek/deepseek-v4-flash
 *   node scripts/ops/collect-agent-answers.mjs --skip-ids Q23,Q31   # 跳过顽固/已失败条目
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GOLD_PATH = join(ROOT, 'tests', 'gold-answers.json');
const SP_PATH = join(ROOT, '.pi', 'prompts', 'medical-agent.md');
const LOG_DIR = join(ROOT, '.pi', 'logs');
// 单条超时：每条均冷启动一个 Pi（加载 72MB KB ~60-90s）+ 免费模型多轮工具调用较慢，
// 280s 对慢速免费通道偏紧，故默认上调至 420s，并允许经 COLLECT_ITEM_TIMEOUT_MS 覆盖。
const PER_ITEM_TIMEOUT_MS = Number(process.env.COLLECT_ITEM_TIMEOUT_MS) || 420_000;

// ---------- 极简 .env 加载（与 lib/llm-judge.mjs 同范式） ----------
function loadEnv() {
  let dir = ROOT;
  for (let i = 0; i < 6; i++) {
    const p = join(dir, '.env');
    if (existsSync(p)) {
      const txt = readFileSync(p, 'utf8');
      for (const raw of txt.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
        if (!m) continue;
        const k = m[1];
        let v = m[2].trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
          v = v.slice(1, -1);
        }
        if (!(k in process.env)) process.env[k] = v;
      }
      break;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
}

// ---------- 参数解析 ----------
function parseArgs(argv) {
  const out = { dryRun: false, only: null, limit: null, force: false, model: 'deepseek/deepseek-v4-flash', skipIds: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--only') out.only = argv[++i].split(',').map((s) => s.trim()).filter(Boolean); // 支持逗号分隔多 id，便于分批串行
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
    else if (a === '--skip-ids') out.skipIds = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--model') out.model = argv[++i];
  }
  return out;
}

// ---------- ANSI 清洗 ----------
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;
function stripAnsi(s) {
  return s.replace(ANSI_RE, '');
}

// ---------- Pi 运行时定位 ----------
// pi 全局命令是 POSIX shell 脚本（/e/nvm4w/nodejs/pi），其内部 exec "$basedir/node"
// （即 nvm4w 的 node v25.8.1 / ABI 141）运行 cli.js。但 pi-knowledge 内嵌的
// better-sqlite3(v11.9.1) 仅有 ABI 127(node22) 预编译产物、node25 无 VS 构建链无法现编，
// 用 node25 拉起会 "NODE_MODULE_VERSION 141 vs 127" 崩 KB 加载。生产 start.sh 真运行时
// 亦锁 node22，故此处必须用 node22(ABI 127) 运行 cli.js 以匹配 KB 绑定，仅 cli.js 仍取自
// nvm4w 安装位。node 路径：PI_NODE > NODE_BIN > managed node22(经 USERPROFILE 推导) > 报错。
function resolveNode22() {
  if (process.env.PI_NODE) return process.env.PI_NODE;
  if (process.env.NODE_BIN) return process.env.NODE_BIN;
  const home = process.env.USERPROFILE || process.env.HOME || '';
  if (home) {
    const verRoot = join(home, '.workbuddy', 'binaries', 'node', 'versions');
    if (existsSync(verRoot)) {
      // 选取 22.x managed node（跨机版本号可能微调，故按前缀匹配取最新）
      const v22 = readdirSync(verRoot).filter((d) => d.startsWith('22.')).sort().pop();
      if (v22) {
        const p = join(verRoot, v22, process.platform === 'win32' ? 'node.exe' : 'bin/node');
        if (existsSync(p)) return p;
      }
    }
  }
  return null;
}

function findPiRuntime() {
  const node22 = resolveNode22();
  // cli.js 位置：优先 PI_CLI env；否则按常见安装位探测。注意本脚本由 Windows Node 运行，
  // existsSync 须用盘符正斜杠路径（"E:/..."），git-bash 风格 "/e/..." 不被识别。
  const cliCandidates = [];
  if (process.env.PI_CLI) cliCandidates.push(process.env.PI_CLI);
  const REL = ['node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js'];
  for (const base of ['E:/nvm4w/nodejs', 'E:/nvm/v25.8.1', 'C:/nvm4w/nodejs']) {
    cliCandidates.push(join(base, ...REL));
  }
  for (const cli of cliCandidates) {
    if (existsSync(cli)) {
      const node = node22 || 'node'; // node22 缺失则退回 PATH node（有 ABI 风险，日志告警）
      if (!node22) console.warn('[warn] 未定位到 node22(ABI 127)，退回 PATH node，KB 加载可能因 ABI 不匹配失败');
      return { node, cli };
    }
  }
  return null;
}

// ---------- 进程树诛杀（对齐 T15 pi-bridge，根治孤儿 Pi 持 KB 锁饿死新实例）----------
// Win: taskkill /T /F 杀整棵子树；Linux: 需 detached 使 Pi 成进程组组长，kill(-pid) 杀全组。
function killTree(pid) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } else {
      process.kill(-pid, 'SIGKILL');
    }
  } catch { /* 进程已退出则忽略 */ }
}

// ---------- 驱动 Pi 非交互作答（直接 spawn node25 + cli.js）----------
const PRELOAD_PATH = join(ROOT, "scripts", "proxy", "preload-fetch-proxy.mjs");
function runPi(argsArray) {
  return new Promise((resolve, reject) => {
    const rt = findPiRuntime();
    const spawnOpts = {
      env: {
        ...process.env,
        NODE_PATH: join(ROOT, "pi", "node_modules"),
      },
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      detached: process.platform !== 'win32', // Linux: 使 Pi 成进程组组长，kill(-pid) 可诛整树
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 忽略，避免非交互下读 stdin 阻塞
    };
    // 注入 preload-fetch-proxy，使 Pi 的 LLM 调用经 proxy 路由到免费后端
    //（proxy 由 start.sh 启动，若未运行则 Pi 直呼 deepseek.com 付费 API）
    const nodeArgs = ["--require", PRELOAD_PATH, rt.cli, ...argsArray];
    const child = rt
      ? spawn(rt.node, nodeArgs, spawnOpts)
      : spawn('pi', argsArray, { ...spawnOpts, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    let settled = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      killTree(child.pid); // 诛整棵子树，防孤儿 Pi 持 KB 锁饿死后续采集
      if (!settled) {
        settled = true;
        reject(new Error(`timeout ${PER_ITEM_TIMEOUT_MS}ms`));
      }
    }, PER_ITEM_TIMEOUT_MS);
    child.on('error', (e) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(e);
      }
    });
    child.on('close', (code) => {
      killTree(child.pid); // 兜底：即便正常退出也诛残留子树
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({
          answer: stripAnsi(stdout).trim(),
          stderr,
          code,
        });
      }
    });
  });
}

// ---------- 原子写回 ----------
function atomicWrite(path, data) {
  const tmp = path + '.tmp';
  writeFileSync(tmp, data, 'utf8');
  renameSync(tmp, path);
}

async function main() {
  loadEnv();
  const args = parseArgs(process.argv.slice(2));

  if (!existsSync(GOLD_PATH)) {
    console.error(`[fatal] gold-answers.json 不存在: ${GOLD_PATH}`);
    process.exit(1);
  }
  if (!existsSync(SP_PATH)) {
    console.error(`[fatal] 系统提示不存在: ${SP_PATH}`);
    process.exit(1);
  }

  const gold = JSON.parse(readFileSync(GOLD_PATH, 'utf8'));
  let items = gold.items.filter((it) =>
    args.only ? args.only.includes(it.id) : args.force || it.systemAnswer == null
  );
  if (args.skipIds.length) {
    items = items.filter((it) => !args.skipIds.includes(it.id));
  }
  if (args.limit != null && Number.isFinite(args.limit)) {
    items = items.slice(0, args.limit);
  }

  if (!items.length) {
    console.log('[info] 无可采集条目（systemAnswer 均已填充，未指定 --force/--only）。');
    return;
  }

  console.log(
    `[info] 待采集 ${items.length} 条 | model=${args.model} | dryRun=${args.dryRun}`
  );

  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  let ok = 0;
  let fail = 0;

  for (const it of items) {
    const piArgs = [
      '--print',
      '--model', args.model,
      '--system-prompt', SP_PATH,
      '--no-session',
      it.q,
    ];
    console.log(`\n=== ${it.id} [${it.department}/${it.difficulty}] ===`);
    console.log(`Q: ${it.q}`);

    if (args.dryRun) {
      console.log(`[dry] pi ${piArgs.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(' ')}`);
      continue;
    }

    const t0 = Date.now();
    try {
      const { answer, stderr, code } = await runPi(piArgs);
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      const hadExtErr = stderr.includes('Extension error');
      if (!answer) {
        fail++;
        console.error(`[fail] ${it.id} 空回答 (code=${code}, ${elapsed}s)`);
        if (stderr) console.error(stderr.split('\n').slice(0, 5).join('\n'));
        continue;
      }
      it.systemAnswer = answer;
      it._agentMeta = {
        model: args.model,
        capturedAt: new Date().toISOString(),
        elapsedSec: parseFloat(elapsed),
        stderrHadExtensionError: hadExtErr,
      };
      ok++;
      console.log(`[ok] ${it.id} 采集成功 (${elapsed}s, ${answer.length} 字${hadExtErr ? ', 含Extension告警' : ''})`);
      // 每条落盘，防中途失败丢失已采成果
      atomicWrite(GOLD_PATH, JSON.stringify(gold, null, 2));
    } catch (e) {
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      fail++;
      console.error(`[error] ${it.id} 采集异常 (${elapsed}s): ${e.message}`);
    }
  }

  console.log(`\n=== 采集完成 === ok=${ok} fail=${fail} total=${items.length}`);
  if (fail > 0 && !args.dryRun) {
    console.error('[warn] 存在失败条目，gold-answers.json 已保存成功部分。');
    process.exitCode = 2;
  }
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
