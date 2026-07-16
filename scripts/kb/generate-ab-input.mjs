// scripts/kb/generate-ab-input.mjs
// 真 B 生成器 —— 打通提示词 A/B 自调优「生成 → 评测」全链路（维度⑤反馈闭环的二次调优量化臂）。
//
// 背景：ab-prompt-eval.mjs 只做「judge 对比」，A/B 两套答案由外部 input JSON 喂入（MVP 解耦，防 41 题生成成本爆炸）。
// 本工具补齐「生成」一侧：对 tests/gold-answers.json 的 q 列表，分别用 A（基线 system prompt）与
// B（变体 system prompt）驱动 Pi Agent 非交互作答，组装为 ab-prompt-eval.mjs 所需的 input JSON。
//
// 设计纪律（贴合项目规范，复用 collect-agent-answers.mjs 的 Pi 驱动范式）：
//   · Pi 驱动三件套（findPiRuntime/runPi/stripAnsi）与 collect-agent-answers.mjs 同源同范式，不另造运行时。
//   · A/B 同模型（--model 统一，默认免费档 sensenova-6.7-flash-lite），仅 system prompt 差 → 对比纯粹。
//   · 每条超时 280s 硬保护（沙箱 TLS 代理下 AbortSignal 不可靠），零静默失败：空回答/异常显式标记并跳过。
//   · 运行时产物落 tests/reports/ab-input.json（gitignore），绝不写回 gold-answers.json（防污染金标准）。
//   · 纯函数（buildItems/findMissing/validateInput/assembleInput）与 LLM 调用解耦，供零 Key 单测。
//
// 用法：
//   node scripts/kb/generate-ab-input.mjs --prompt-b prompts/medical-agent.v2.md --limit 3
//   node scripts/kb/generate-ab-input.mjs --prompt-b ... --model deepseek/deepseek-v4-flash --only Q01,Q02
//   node scripts/kb/generate-ab-input.mjs --dry-run          # 仅打印将执行的 pi 命令
//   node scripts/kb/generate-ab-input.mjs --out my-ab.json   # 指定输出路径
//
// 注意：未指定 --prompt-b 时 B 默认等同 A（仅作 smoke，四维对比应全持平）；真实 A/B 须传 --prompt-b 变体文件。

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { findPiRuntime, killTree } from "../lib/pi-runner.mjs"; // P0-5 修复：抽离公共 Pi 驱动，跨平台树杀

const __dirname = dirname(fileURLToPath(import.meta.url));

// 稳健解析项目根：向上递归找 package.json（不写死 ../ 层数，避免文件迁移越界）。
function findProjectRoot(startDir) {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "package.json"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir;
}
const ROOT = findProjectRoot(__dirname);
const GOLD_PATH = join(ROOT, "tests", "gold-answers.json");
const DEFAULT_A_PROMPT = join(ROOT, ".pi", "prompts", "medical-agent.md");
const DEFAULT_MODEL = "sensenova/sensenova-6.7-flash-lite";
const PER_ITEM_TIMEOUT_MS = 280_000;
const ANSI_RE = /\x1b\[[0-9;?]*[A-Za-z]/g;

// ---------------- 纯函数（零 Key 单测）----------------

/**
 * 组装 A/B input items。
 * @param {Array} targetItems  gold 中本次要跑的目标条目（含 id/q/gtSources/referenceAnswer）
 * @param {Object<string,{answerA?:string,answerB?:string}>} answersById  id -> {answerA, answerB}
 * @param {{promptA?:string, promptB?:string}} [opts]
 * @returns {Array<{id:string,q:string,gtSources:string[],referenceAnswer:string,answerA:string,answerB:string}>}
 */
export function buildItems(targetItems, answersById, { promptA = "", promptB = "" } = {}) {
  return (targetItems || []).map((it) => {
    const ans = answersById[it.id] || {};
    return {
      id: it.id,
      q: it.q,
      gtSources: Array.isArray(it.gtSources) ? it.gtSources : [],
      referenceAnswer: it.referenceAnswer || "",
      answerA: ans.answerA || "",
      answerB: ans.answerB || "",
    };
  });
}

/** 标记 answerA/answerB 缺失（空串/未定义/非串）的条目 id。 */
export function findMissing(items) {
  const miss = [];
  for (const it of items || []) {
    if (!it.answerA || typeof it.answerA !== "string") miss.push(it.id);
    else if (!it.answerB || typeof it.answerB !== "string") miss.push(it.id);
  }
  return miss;
}

/** 校验最终 input 结构合法（items 每元素须有 id/q/answerA/answerB 非空字符串）。 */
export function validateInput(obj) {
  const errors = [];
  if (!obj || typeof obj !== "object") return { ok: false, errors: ["input 非对象"] };
  if (!Array.isArray(obj.items)) return { ok: false, errors: ["items 非数组"] };
  if (obj.items.length === 0) errors.push("items 为空（A/B 至少需一对）");
  obj.items.forEach((it, i) => {
    if (!it.id) errors.push(`items[${i}] 缺 id`);
    if (!it.q) errors.push(`items[${i}](${it.id || "?"}) 缺 q`);
    if (!it.answerA || typeof it.answerA !== "string") errors.push(`items[${i}](${it.id || "?"}) answerA 缺失/非串`);
    if (!it.answerB || typeof it.answerB !== "string") errors.push(`items[${i}](${it.id || "?"}) answerB 缺失/非串`);
  });
  return { ok: errors.length === 0, errors };
}

/** 组装完整 input 对象（补默认 meta）。 */
export function assembleInput({ meta = {}, items = [] } = {}) {
  return {
    meta: {
      promptA: meta.promptA || "",
      promptB: meta.promptB || "",
      note: meta.note || "由 generate-ab-input.mjs 自动生成",
      generatedAt: new Date().toISOString(),
    },
    items,
  };
}

// ---------------- Pi 驱动（抽离至 scripts/lib/pi-runner.mjs）----------------

function stripAnsi(s) {
  return s.replace(ANSI_RE, "");
}

/** 驱动 Pi 非交互作答；超时硬杀，异常 reject（由调用方兜底标记跳过）。 */
function runPi(argsArray, { timeoutMs = PER_ITEM_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const rt = findPiRuntime();
    const spawnOpts = {
      env: process.env,
      cwd: ROOT,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"], // stdin 忽略，避免非交互下读 stdin 阻塞
    };
    const child = rt
      ? spawn(rt.node, [rt.cli, ...argsArray], spawnOpts)
      : spawn("pi", argsArray, { ...spawnOpts, shell: process.platform === "win32" });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    const timer = setTimeout(() => {
      try { killTree(child.pid); } catch {}
      reject(new Error(`timeout ${timeoutMs}ms`));
    }, timeoutMs);
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ answer: stripAnsi(stdout).trim(), stderr, code });
    });
  });
}

// ---------------- CLI ----------------

function parseArgs(argv) {
  const a = {
    promptA: DEFAULT_A_PROMPT,
    promptB: DEFAULT_A_PROMPT,
    model: DEFAULT_MODEL,
    limit: 3,
    out: null,
    only: null,
    dryRun: false,
  };
  for (let i = 2; i < argv.length; i++) {
    const x = argv[i];
    if (x === "--prompt-a" && argv[i + 1]) a.promptA = argv[++i];
    else if (x === "--prompt-b" && argv[i + 1]) a.promptB = argv[++i];
    else if (x === "--model" && argv[i + 1]) a.model = argv[++i];
    else if (x === "--limit" && argv[i + 1]) a.limit = parseInt(argv[++i], 10);
    else if (x === "--out" && argv[i + 1]) a.out = argv[++i];
    else if (x === "--only" && argv[i + 1]) a.only = argv[++i];
    else if (x === "--dry-run") a.dryRun = true;
  }
  return a;
}

function isMain() {
  return (
    !!process.argv[1] &&
    basename(import.meta.url) === basename("file://" + (process.argv[1] || "").replace(/\\/g, "/"))
  );
}

async function main() {
  const args = parseArgs(process.argv);
  if (!existsSync(GOLD_PATH)) {
    console.error(`[fatal] gold 不存在: ${GOLD_PATH}`);
    process.exit(1);
  }
  if (!existsSync(args.promptA)) {
    console.error(`[fatal] A prompt 不存在: ${args.promptA}`);
    process.exit(1);
  }
  if (!existsSync(args.promptB)) {
    console.error(`[fatal] B prompt 不存在: ${args.promptB}`);
    process.exit(1);
  }

  const gold = JSON.parse(readFileSync(GOLD_PATH, "utf-8"));
  let items = Array.isArray(gold.items) ? gold.items : [];
  if (args.only) {
    const ids = args.only.split(",").map((s) => s.trim()).filter(Boolean);
    items = items.filter((it) => ids.includes(it.id));
  }
  if (args.limit && args.limit > 0) items = items.slice(0, args.limit);

  console.log(
    `[info] 目标 ${items.length} 条 | model=${args.model} | A=${basename(args.promptA)} B=${basename(args.promptB)} | dryRun=${args.dryRun}`,
  );

  const answersById = {};
  for (const it of items) {
    const piArgsA = ["--print", "--model", args.model, "--system-prompt", args.promptA, "--no-session", it.q];
    const piArgsB = ["--print", "--model", args.model, "--system-prompt", args.promptB, "--no-session", it.q];
    console.log(`\n=== ${it.id} [${it.department || "?"}] ===\nQ: ${it.q}`);

    if (args.dryRun) {
      console.log(`[dry A] pi ${piArgsA.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}`);
      console.log(`[dry B] pi ${piArgsB.map((x) => (/\s/.test(x) ? JSON.stringify(x) : x)).join(" ")}`);
      answersById[it.id] = { answerA: "", answerB: "" };
      continue;
    }

    // A 侧
    try {
      const ra = await runPi(piArgsA);
      if (!ra.answer) {
        console.error(`[fail A] ${it.id} 空回答 (code=${ra.code})`);
        answersById[it.id] = { answerA: "", answerB: "" };
      } else {
        answersById[it.id] = { answerA: ra.answer, answerB: "" };
        console.log(`[ok A] ${it.id} ${ra.answer.length} 字`);
      }
    } catch (e) {
      console.error(`[err A] ${it.id}: ${e.message}`);
      answersById[it.id] = { answerA: "", answerB: "" };
    }

    // B 侧
    try {
      const rb = await runPi(piArgsB);
      if (!rb.answer) {
        console.error(`[fail B] ${it.id} 空回答 (code=${rb.code})`);
      } else {
        answersById[it.id].answerB = rb.answer;
        console.log(`[ok B] ${it.id} ${rb.answer.length} 字`);
      }
    } catch (e) {
      console.error(`[err B] ${it.id}: ${e.message}`);
    }
  }

  if (args.dryRun) {
    console.log("\n[dry-run] 已完成命令预览，未触发 LLM、未写文件。");
    return;
  }

  const built = buildItems(items, answersById, { promptA: args.promptA, promptB: args.promptB });
  const missing = findMissing(built);
  if (missing.length) {
    console.warn(`[warn] ${missing.length} 条缺答案（A/B 之一空）: ${missing.join(",")}`);
  }

  const input = assembleInput({
    meta: { promptA: args.promptA, promptB: args.promptB, note: `model=${args.model}` },
    items: built,
  });
  const v = validateInput(input);
  if (!v.ok) {
    console.error("[fatal] input 校验失败:", v.errors.join("; "));
    process.exit(1);
  }

  const outPath = args.out || join(ROOT, "tests", "reports", "ab-input.json");
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(input, null, 2), "utf-8");
  console.log(`\n=== 生成完成 === 输出: ${outPath} (${built.length} 条)`);
}

if (isMain()) {
  main().catch((e) => {
    console.error("[fatal]", e);
    process.exit(1);
  });
}
