// scripts/service/circuit-breaker.mjs
// 通用熔断器 + 重试（纯逻辑、零依赖、可注入时钟便于单测）
//
// CircuitBreaker：closed → open（失败达阈值）→ half-open（冷却后放一个探针）
//   → 探针成功达 successThreshold 回 closed；探针失败回 open。
// retry：指数退避重试，由 shouldRetry(err) 决定是否可重试。

export class CircuitOpenError extends Error {
  constructor(message, state) {
    super(message);
    this.name = "CircuitOpenError";
    this.state = state;
  }
}

export class CircuitBreaker {
  /**
   * @param {object} opts
   * @param {number} [opts.failureThreshold=5]   连续失败多少次后熔断
   * @param {number} [opts.cooldownMs=30000]     熔断后冷却时长（期间直接拒绝）
   * @param {number} [opts.successThreshold=2]   half-open 需连续成功多少次才恢复
   * @param {number} [opts.timeoutMs=60000]      单次调用超时（超时才计失败）
   * @param {Array<new (...a: any) => Error>} [opts.ignoreErrors]  不计入下游故障的错误类型（如池满背压 PoolFullError），避免污染熔断阈值
   * @param {() => number} [opts.now]            时钟（测试可注入）
   */
  constructor(opts = {}) {
    this.failureThreshold = opts.failureThreshold ?? 5;
    this.cooldownMs = opts.cooldownMs ?? 30000;
    this.successThreshold = opts.successThreshold ?? 2;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.ignoreErrors = opts.ignoreErrors || [];
    this.now = opts.now || (() => Date.now());

    this.state = "closed"; // closed | open | half-open
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = 0;
    this.totalCalls = 0;
    this.totalFailures = 0;
    this.totalRejected = 0; // 熔断期间被拒
  }

  get stats() {
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalCalls: this.totalCalls,
      totalFailures: this.totalFailures,
      totalRejected: this.totalRejected,
    };
  }

  _shouldReject() {
    if (this.state === "open") {
      if (this.now() - this.openedAt >= this.cooldownMs) {
        this.state = "half-open";
        this.consecutiveSuccesses = 0;
        return false;
      }
      return true;
    }
    return false;
  }

  /**
   * 执行受保护调用。熔断/超时时抛错（CircuitOpenError 或原错误）。
   * @param {() => Promise<any>} fn
   */
  async exec(fn) {
    this.totalCalls++;
    if (this._shouldReject()) {
      this.totalRejected++;
      throw new CircuitOpenError(
        "Circuit breaker is open; fast-failing call",
        this.state,
      );
    }

    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Call timed out (circuit breaker)")),
        this.timeoutMs,
      );
    });

    try {
      const result = await Promise.race([fn(), timeoutPromise]);
      this._onSuccess();
      return result;
    } catch (err) {
      // 背压/瞬态信号（如 PoolFullError）不计为下游故障，避免污染熔断阈值
      if (this.ignoreErrors.some((C) => err instanceof C)) {
        throw err;
      }
      this._onFailure();
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  _onSuccess() {
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses++;
    if (
      this.state === "half-open" &&
      this.consecutiveSuccesses >= this.successThreshold
    ) {
      this.state = "closed";
    }
  }

  _onFailure() {
    this.totalFailures++;
    this.consecutiveFailures++;
    this.consecutiveSuccesses = 0;
    if (this.state === "half-open") {
      this.state = "open";
      this.openedAt = this.now();
    } else if (this.consecutiveFailures >= this.failureThreshold) {
      this.state = "open";
      this.openedAt = this.now();
    }
  }
}

/**
 * 指数退避重试包装。
 * @param {() => Promise<any>} fn
 * @param {object} opts
 * @param {number} [opts.retries=2]      额外重试次数（不含首次）
 * @param {number} [opts.backoffMs=400]  首次退避
 * @param {number} [opts.factor=2]       退避倍增
 * @param {(err: Error, attempt: number) => boolean} [opts.shouldRetry]  返回 false 立即放弃
 * @param {() => number} [opts.sleep]    可注入（测试用），默认 setTimeout
 */
export async function retry(fn, opts = {}) {
  const retries = opts.retries ?? 2;
  const backoffMs = opts.backoffMs ?? 400;
  const factor = opts.factor ?? 2;
  const shouldRetry = opts.shouldRetry || (() => true);
  const sleep = opts.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));

  let attempt = 0;
  let lastErr;
  while (attempt <= retries) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= retries || !shouldRetry(err, attempt)) break;
      const wait = backoffMs * Math.pow(factor, attempt);
      await sleep(wait);
      attempt++;
    }
  }
  throw lastErr;
}
