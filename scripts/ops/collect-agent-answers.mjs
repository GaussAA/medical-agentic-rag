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
 *   node scripts/ops/collect-agent-answers.mjs --only Q01      # 仅采指定 id
 *   node scripts/ops/collect-agent-answers.mjs --limit 3       # 仅采前 3 条
 *   node scripts/ops/collect-agent-answers.mjs --force         # 覆盖已有 systemAnswer
 *   node scripts/ops/collect-agent-answers.mjs --model deepseek/deepseek-v4-flash
 */
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..', '..');
const GOLD_PATH = join(ROOT, 'tests', 'gold-answers.json');
const SP_PATH = join(ROOT, 'prompts', 'medical-agent.md');
const LOG_DIR = join(ROOT, 'logs');
const PER_ITEM_TIMEOUT_MS = 280_000;

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
  const out = { dryRun: false, only: null, limit: null, force: false, model: 'deepseek/deepseek-v4-flash' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') out.dryRun = true;
    else if (a === '--force') out.force = true;
    else if (a === '--only') out.only = argv[++i];
    else if (a === '--limit') out.limit = parseInt(argv[++i], 10);
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
// pi 全局命令是 POSIX shell 脚本（/e/nvm4w/nodejs/pi），其内部优先 exec
// "$basedir/node"（即 nvm4w 的 node v25.8.1）运行 cli.js。脚本式经 shell 包装
// 易触发 stdin 阻塞 / 环境歧义导致超时，故直接定位 node25 + cli.js 调用，
// 最贴近交互式 `pi --print` 的成功路径。
function findPiRuntime() {
  if (process.env.PI_NODE && process.env.PI_CLI) return { node: process.env.PI_NODE, cli: process.env.PI_CLI };
  const bases = ['/e/nvm4w/nodejs', 'C:\\nvm4w\\nodejs'];
  for (const base of bases) {
    const node = join(base, 'node');
    const cli = join(base, 'node_modules', '@earendil-works', 'pi-coding-agent', 'dist', 'cli.js');
    if (existsSync(node) && existsSync(cli)) return { node, cli };
  }
  return null;
}

// ---------- 驱动 Pi 非交互作答（直接 spawn node25 + cli.js）----------
function runPi(argsArray) {
  return new Promise((resolve, reject) => {
    const rt = findPiRuntime();
    const spawnOpts = {
      env: process.env,
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], // stdin 忽略，避免非交互下读 stdin 阻塞
    };
    const child = rt
      ? spawn(rt.node, [rt.cli, ...argsArray], spawnOpts)
      : spawn('pi', argsArray, { ...spawnOpts, shell: process.platform === 'win32' });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* ignore */ }
      reject(new Error(`timeout ${PER_ITEM_TIMEOUT_MS}ms`));
    }, PER_ITEM_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        answer: stripAnsi(stdout).trim(),
        stderr,
        code,
      });
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
    args.only ? it.id === args.only : args.force || it.systemAnswer == null
  );
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
