// scripts/service/pi-bridge.mjs
// PiWorker —— 把 Pi Agent 的 RPC 子进程封装成「一问一答」可编程桥接。
//
// 为什么不用内置 RpcClient：
//   内置 RpcClient.start() 写死 spawn("node", ...)，无法指定 node 二进制、
//   也无法注入 --require 预加载；本环境 better-sqlite3 需 managed Node 22，
//   且项目 LLM 调用须经 preload-fetch-proxy.mjs 劫持到本地代理。故自管 spawn。
//
// 协议：Pi --mode rpc 走 stdio JSONL（命令写 stdin、响应/事件读 stdout）。
//
// 结构化输出（ask 返回）：
//   { answer, citations[], evidence[], safety{guardHits[],blocked}, stats, model, traceId, ts }

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { resolveNodeBin, toNativePath } from "./node-bin.mjs";

// 已知安全护栏工具名（命中即计入 safety.guardHits）
const GUARD_TOOL_HINTS = [
  "bash_guard",
  "scope_guard",
  "faithfulness_guard",
  "conflict_detector",
  "patient_profile",
  "phi",
  "safety",
  "audit",
  "guard",
];

function resolvePiCli() {
  if (process.env.PI_CLI_PATH && existsSync(process.env.PI_CLI_PATH))
    return process.env.PI_CLI_PATH;
  // 优先 npm 全局安装的 pi-coding-agent（Docker 镜像内 pi/ 源码不打包）
  try {
    return require.resolve("@earendil-works/pi-coding-agent/dist/cli.js");
  } catch {
    // 兜底：npm 全局安装路径（Docker 镜像下 npm install -g 的位置）
    const globalPath = "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/dist/cli.js";
    if (existsSync(globalPath)) return globalPath;
    // 终极兜底：本地 pi/ 源码路径（开发环境/非容器使用）
    const local = join(
      process.cwd(),
      "pi",
      "packages",
      "coding-agent",
      "dist",
      "cli.js",
    );
    if (existsSync(local)) return local;
    return local; // 报错时给出明确信息
  }
}

function extractText(content) {
  if (!content) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" ? p.text || "" : String(p || "")))
      .join("");
  }
  if (typeof content === "object") return content.text || "";
  return String(content);
}

function short(s, n = 600) {
  const t = String(s ?? "");
  return t.length > n ? t.slice(0, n) + "…" : t;
}

// 从工具结果里尽量抽取引用（来源/标题/章节/文档）
function pushCite(cites, seen, source, tool) {
  const k = String(source).trim();
  if (!k || seen.has(k)) return;
  seen.add(k);
  cites.push({ source: short(k, 200), tool });
}

// 从工具结果文本抽取引用来源（兼容结构化 JSON 与格式化文本两种形态）
function extractCitationsFromText(text, tool, cites, seen) {
  if (!text) return;
  const trimmed = String(text).trim();
  // 1) 结构化：文本本身是可解析 JSON 且含 source/title 字段
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed);
      const arr = Array.isArray(obj) ? obj : [obj];
      let got = false;
      for (const o of arr) {
        if (o && typeof o === "object") {
          const src =
            o.source ||
            o.src ||
            o.doc ||
            o.document ||
            o.file ||
            o.title ||
            o.name;
          if (src) {
            pushCite(cites, seen, src, tool);
            got = true;
          }
        }
      }
      if (got) return;
    } catch {
      /* 非 JSON，走文本规则 */
    }
  }
  // 2) 键值：来源/标题/文献/出处 …
  const kvRe =
    /(?:来源|标题|文献|文档|出处|source|title|doc)\s*[:：]\s*([^\n，。；;]{2,120})/gi;
  let m;
  while ((m = kvRe.exec(text))) pushCite(cites, seen, m[1], tool);
  // 3) 指南/规范/共识/标准 等文档名（含《》书名号）
  const titleRe =
    /[《「]?([^，。\n《「》」]{2,40}?(?:指南|规范|专家共识|共识|标准|诊疗|路径|pathway|guideline))[》」]?/gi;
  while ((m = titleRe.exec(text))) pushCite(cites, seen, m[1], tool);
  // 4) 文件名（.pdf/.md/.txt/.docx）
  const fileRe =
    /([\w\-．。（）()\u4e00-\u9fa5]{2,80}\.(?:pdf|md|txt|docx?))/gi;
  while ((m = fileRe.exec(text))) pushCite(cites, seen, m[1], tool);
}

function assembleResult({
  messages,
  entries,
  stats,
  model,
  traceId,
  durationMs,
}) {
  const msgs = Array.isArray(messages) ? messages : [];

  // 最终 assistant 文本（取最后一条非空 assistant）
  let answer = "";
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m && (m.role === "assistant" || m.role === "ai")) {
      const t = extractText(m.content);
      if (t) {
        answer = t;
        break;
      }
    }
  }

  const evidence = [];
  const guardHits = new Set();
  const citations = [];
  const citeSeen = new Set();
  let blocked = false;
  const BLOCK_WORDS = [
    "拒绝",
    "越界",
    "拦截",
    "reject",
    "denied",
    "block",
    "blocked",
  ];

  // 工具结果以 role:"toolResult" 消息承载（Pi 真实形态）
  for (const m of msgs) {
    const role = m?.role || m?.message?.role;
    if (role !== "toolResult") continue;
    const toolName = m?.toolName || m?.message?.toolName || "unknown";
    const text = extractText(m?.content ?? m?.message?.content ?? "");
    evidence.push({ tool: toolName, summary: short(text) });
    extractCitationsFromText(text, toolName, citations, citeSeen);
    const low = String(toolName).toLowerCase();
    if (GUARD_TOOL_HINTS.some((h) => low.includes(h))) {
      guardHits.add(toolName);
      if (BLOCK_WORDS.some((w) => text.toLowerCase().includes(w)))
        blocked = true;
    }
  }

  return {
    answer,
    citations,
    evidence,
    safety: { guardHits: [...guardHits], blocked },
    stats: stats || null,
    model,
    traceId,
    durationMs,
  };
}

export class PiWorker {
  constructor(opts = {}) {
    this.nodeBin = toNativePath(opts.nodeBin || resolveNodeBin());
    this.cliPath = opts.cliPath || resolvePiCli();
    this.cwd = opts.cwd || process.cwd();
    this.preloadPath =
      opts.preloadPath ||
      join(this.cwd, "scripts", "proxy", "preload-fetch-proxy.mjs");
    this.systemPrompt = opts.systemPrompt;
    this.model = opts.model || "sensenova/sensenova-6.7-flash-lite";
    this.sessionDir = opts.sessionDir || join(this.cwd, ".pi", "sessions");
    this.timeoutMs = opts.timeoutMs || 120000;
    this.log = opts.log || (() => {});

    this.proc = null;
    this.started = false;
    this.currentModel = this.model;
    this._listeners = new Set();
    this._pending = new Map();
    this._reqId = 0;
    this._stderr = "";
    this._exitError = null;
    this._stopReader = null;
    this._wedged = false; // 单 Pi 卡死标记（"Agent is already processing" / 超时未 settle）
    // 单 Pi 串行锁：同 worker 同时仅一个 ask 在飞（Pi agent 单飞，
    // 并发 prompt 会互相污染 final answer 与 get_messages 读取）。
    this._askLock = Promise.resolve();
  }

  isAlive() {
    return (
      !!this.proc &&
      this.proc.exitCode === null &&
      !this._exitError &&
      !this._wedged
    );
  }

  async start() {
    if (this.started) throw new Error("PiWorker already started");
    const argv = [];
    if (this.preloadPath && existsSync(this.preloadPath)) {
      argv.push("--require", this.preloadPath);
    }
    argv.push(this.cliPath, "--mode", "rpc", "--model", this.model);
    if (this.systemPrompt) argv.push("--system-prompt", this.systemPrompt);
    argv.push("--session-dir", this.sessionDir);

    this.log(
      `[pi-bridge] spawn cwd=${this.cwd} nodeBin=${this.nodeBin} model=${this.model} ${argv.join(" ")}`,
    );
    const child = spawn(this.nodeBin, argv, {
      cwd: this.cwd,
      env: { ...process.env, ...(this.env || {}) },
      stdio: ["pipe", "pipe", "pipe"],
      // 非 Windows 下 detached，使 Pi 成为进程组组长，关停时可整组 SIGKILL；
      // Windows 下用 taskkill /T 杀整棵子树（含 Pi 可能 fork 的子进程），避免孤儿持 KB 锁。
      detached: process.platform !== "win32",
    });
    this.proc = child;

    child.stderr?.on("data", (d) => {
      this._stderr += d.toString();
      // 例程诊断仅落文件，不冲 TUI/终端（遵循项目诊断日志规约）
      this.log(`[pi-bridge:stderr] ${short(d.toString(), 300)}`);
    });
    child.once("exit", (code, sig) => {
      const err = new Error(`Pi process exited (code=${code} signal=${sig})`);
      this._exitError = err;
      this._rejectAll(err);
      this._listeners.clear();
    });
    child.once("error", (e) => {
      this._exitError = e;
      this._rejectAll(e);
    });

    // 严格按 \n 切分 JSONL（readline 会误切 U+2028/2029，故自管）
    let buf = "";
    child.stdout?.on("data", (d) => {
      buf += d.toString();
      let idx;
      while ((idx = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, idx);
        buf = buf.slice(idx + 1);
        if (line.trim()) this._handleLine(line);
      }
    });

    this.started = true;
    // 就绪探针：等待首个 get_state 成功。Pi 冷启动需加载 ~72MB KB（WAL 回放），
    // 常需 30–90s，故超时放宽至 120s，避免误判失败而反复丢弃/重建 worker（泄漏进程）。
    try {
      await this.request({ type: "get_state" }, 120000);
    } catch (e) {
      // 失败则杀整棵子树，杜绝半启动 Pi 残留持 KB 锁
      await this._killTree(this.proc?.pid);
      this.proc = null;
      throw new Error(
        `Pi failed to become ready: ${e.message}. Stderr: ${short(this._stderr, 500)}`,
      );
    }
  }

  _handleLine(line) {
    let data;
    try {
      data = JSON.parse(line);
    } catch {
      return; // 忽略非 JSON 行
    }
    if (
      data &&
      data.type === "response" &&
      data.id &&
      this._pending.has(data.id)
    ) {
      const p = this._pending.get(data.id);
      this._pending.delete(data.id);
      clearTimeout(p.timer);
      if (data.success) p.resolve(data);
      else p.reject(new Error(data.error || "Pi command failed"));
      return;
    }
    for (const l of this._listeners) {
      try {
        l(data);
      } catch {
        /* 监听器异常不影响主链路 */
      }
    }
  }

  _rejectAll(err) {
    for (const p of this._pending.values()) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this._pending.clear();
  }

  // 杀整棵子树（根治孤儿 Pi 持全局 KB 写锁饿死新实例的运营故障）。
  // Windows: taskkill /T /F 直接强杀子树；非 Windows: 进程组 SIGTERM→SIGKILL。
  async _killTree(pid) {
    if (!pid) return;
    if (process.platform === "win32") {
      await new Promise((res) => {
        const cp = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
          stdio: "ignore",
        });
        cp.on("close", () => res());
        cp.on("error", () => res());
      });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      try {
        this.proc?.kill("SIGTERM");
      } catch {
        /* noop */
      }
    }
    await new Promise((r) => setTimeout(r, 800));
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        this.proc?.kill("SIGKILL");
      } catch {
        /* noop */
      }
    }
  }

  _cleanup() {
    try {
      this.proc?.kill("SIGTERM");
    } catch {
      /* noop */
    }
    this.proc = null;
  }

  onEvent(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  request(command, timeoutMs = 30000) {
    if (!this.proc) return Promise.reject(new Error("PiWorker not started"));
    if (this._exitError) return Promise.reject(this._exitError);
    if (this.proc.exitCode !== null) {
      return Promise.reject(
        new Error(`Pi exited (code=${this.proc.exitCode})`),
      );
    }
    const id = `req_${++this._reqId}`;
    const full = { ...command, id };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`Timeout waiting for response to ${command.type}`));
      }, timeoutMs);
      this._pending.set(id, { resolve, reject, timer });
      try {
        this.proc.stdin.write(JSON.stringify(full) + "\n");
      } catch (e) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(e);
      }
    });
  }

  async promptAndWait(message, timeoutMs = this.timeoutMs) {
    const settled = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error("Timeout waiting for agent_settled"));
      }, timeoutMs);
      const off = this.onEvent((e) => {
        if (e && e.type === "agent_settled") {
          clearTimeout(timer);
          off();
          resolve();
        }
      });
    });
    // streamingBehavior: followUp —— Pi 单飞时若恰在 processing，排队而非拒绝（避免竞态 500）
    await this.request(
      { type: "prompt", message, streamingBehavior: "followUp" },
      timeoutMs,
    );
    await settled;
  }

  // 单 Pi 串行：同一 worker 同时仅一个 ask 在飞，避免并发 prompt 互相污染
  // final answer 与 get_messages 读取（Pi agent 为单飞状态机）。
  async ask(question, opts = {}) {
    return this._withAskLock(() => this._askUnsafe(question, opts));
  }

  _withAskLock(fn) {
    const prev = this._askLock;
    let release;
    this._askLock = new Promise((r) => (release = r));
    return (async () => {
      try {
        await prev;
        return await fn();
      } finally {
        release();
      }
    })();
  }

  async _askUnsafe(
    question,
    { timeoutMs = this.timeoutMs, traceId = randomUUID() } = {},
  ) {
    try {
      const t0 = Date.now();
      await this.promptAndWait(question, timeoutMs);
      const [messages, entries, stats] = await Promise.all([
        this.request({ type: "get_messages" }, 15000).then(
          (r) => r.data?.messages ?? [],
        ),
        this.request({ type: "get_entries" }, 15000).then(
          (r) => r.data?.entries ?? [],
        ),
        this.request({ type: "get_session_stats" }, 15000)
          .then((r) => r.data ?? null)
          .catch(() => null),
      ]);
      const durationMs = Date.now() - t0;
      return {
        ok: true,
        ...assembleResult({
          messages,
          entries,
          stats,
          model: this.currentModel,
          traceId,
          durationMs,
        }),
      };
    } catch (e) {
      // Pi 单飞易卡死：客户端断开后 Pi 内部仍 processing 且不再 settle，
      // 或并发竞态命中 "Agent is already processing"。此时单 Pi 已不可用，
      // 杀整棵子树并标记 wedge，下次 getWorker 自动重建（自愈），避免拖垮整个 Pod。
      const msg = String(e?.message || "");
      if (msg.includes("already processing") || msg.includes("Timeout")) {
        this._wedged = true;
        try {
          await this._killTree(this.proc?.pid);
        } catch {
          /* noop */
        }
        this.proc = null;
      }
      throw e;
    }
  }

  async setModel(provider, modelId) {
    await this.request({ type: "set_model", provider, modelId }, 15000);
    this.currentModel = `${provider}/${modelId}`;
    return this.currentModel;
  }

  async getAvailableModels() {
    const r = await this.request({ type: "get_available_models" }, 15000);
    return r.data?.models ?? [];
  }

  async stop() {
    if (!this.proc) return;
    const pid = this.proc.pid;
    this.started = false;
    this._wedged = false;
    await this._killTree(pid);
    this.proc = null;
  }

  // 关停专用：与 stop 同路径（整棵子树强杀），语义上用于进程退出前的清理。
  async dispose() {
    if (!this.proc) return;
    const pid = this.proc.pid;
    this.started = false;
    this._wedged = false;
    this._exitError = null;
    await this._killTree(pid);
    this.proc = null;
  }
}

export { resolveNodeBin, resolvePiCli, assembleResult, extractText };
