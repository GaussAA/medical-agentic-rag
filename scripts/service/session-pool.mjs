// scripts/service/session-pool.mjs
// 会话池（T15 修订版）：**每 Pod 单一 Pi worker**。
//
// 关键约束（压测结论）：Pi 在本机/本 KB 为单实例——任意第二个并发 Pi 进程
// 会硬崩（Windows code=3221225794 / 静默 exit 1，KB WAL 写锁争用）。因此
// 一个 Pod 内只能有「一个」Pi 进程；所有 ask（无论 sessionId）都路由到它，
// 由 worker 内 _askLock 串行化。并发吞吐靠 HPA 横向扩 Pod 实现，而非多 Pi。
//
// sessionId 在此仅作 API 层记账（熔断键、活跃会话列表、空闲回收），
// 不再派生独立 Pi 子进程（那会崩溃）。多轮对话在单一 Pi 会话内自然累积。
//
// workerFactory() => PiWorker（未启动）。生产环境造真实 PiWorker，单测注入 mock。

export class PoolFullError extends Error {
  constructor(message) {
    super(message);
    this.name = "PoolFullError";
    this.statusCode = 429;
  }
}

export class SessionPool {
  constructor(opts = {}) {
    this.workerFactory = opts.workerFactory;
    if (typeof this.workerFactory !== "function") {
      throw new Error("SessionPool 需要 workerFactory() => PiWorker");
    }
    this.maxSessions = opts.maxSessions ?? 8;
    this.idleTtlMs = opts.idleTtlMs ?? 10 * 60 * 1000;
    this.log = opts.log || (() => {});
    this.worker = null; // 单 Pi worker（每 Pod 单实例）
    this.sessions = new Map(); // sessionId -> lastUsed（仅 API 层记账/熔断）
    this._timer = null;
    this._started = false;
  }

  start() {
    if (this._started) return;
    this._started = true;
    this._timer = setInterval(() => this._sweep(), 60 * 1000);
    if (this._timer.unref) this._timer.unref();
  }

  stopSweeper() {
    if (this._timer) clearInterval(this._timer);
    this._timer = null;
  }

  // 预热：启动期主动拉起单 Pi worker，使 Pod 启动后即可服务（K8s readiness 立即可过）
  async warmup() {
    await this._ensureWorker();
  }

  async _ensureWorker() {
    if (this.worker && this.worker.isAlive()) return this.worker;
    if (this.worker) {
      try {
        await this.worker.stop();
      } catch {
        /* noop */
      }
    }
    const w = this.workerFactory("__default__");
    await w.start();
    this.worker = w;
    return w;
  }

  async getWorker() {
    return this._ensureWorker();
  }

  async ask(sessionId, question, opts = {}) {
    if (sessionId) this.sessions.set(sessionId, Date.now());
    const w = await this.getWorker();
    return w.ask(question, opts);
  }

  async setModel(provider, modelId, sessionId) {
    const w = await this.getWorker();
    return w.setModel(provider, modelId);
  }

  async getAvailableModels(sessionId) {
    const w = await this.getWorker();
    return w.getAvailableModels();
  }

  listSessions() {
    const now = Date.now();
    const items = [];
    for (const [id, t] of this.sessions) {
      items.push({ sessionId: id, alive: true, idleMs: now - t });
    }
    return { defaultAlive: !!this.worker?.isAlive(), sessions: items };
  }

  _sweep() {
    const now = Date.now();
    for (const [id, t] of [...this.sessions]) {
      if (now - t >= this.idleTtlMs) this.sessions.delete(id);
    }
    // worker 失效则置空，下次请求自动重建（自愈）
    if (this.worker && !this.worker.isAlive()) {
      this.log("[pool] 单 Pi worker 已失效，下次请求将重建");
      this.worker = null;
    }
  }

  async stopAll() {
    this.stopSweeper();
    if (this.worker) {
      try {
        await this.worker.stop();
      } catch {
        /* noop */
      }
    }
    this.worker = null;
    this.sessions.clear();
  }

  // 关停专用：整棵子树强杀（dispose），不等待优雅退出，确保无孤儿 Pi 持锁
  async dispose() {
    this.stopSweeper();
    if (this.worker) {
      try {
        await this.worker.dispose();
      } catch {
        /* noop */
      }
    }
    this.worker = null;
    this.sessions.clear();
  }
}
