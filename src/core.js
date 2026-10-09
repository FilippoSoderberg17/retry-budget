/**
 * RetryBudget core: a shared token bucket that throttles retries so a failing
 * dependency cannot amplify load via retry storms.
 *
 * Design decisions (documented so callers know exactly what they get):
 *
 * 1. Refill is "every X ms, add one token, capping at maxTokens". This is
 *    simpler and more predictable than continuous linear refill, and it is
 *    easy to reason about under a fake clock in tests.
 *
 * 2. withRetry is NOT recursive: it applies the budget and calls fn exactly
 *    once per invocation. The caller is responsible for the retry loop.
 *    This avoids unbounded call-stack growth and keeps the budget's contract
 *    to a single yes/no on "is a retry allowed right now". A wrapper that
 *    also implemented retry loops would have to pick a backoff policy, which
 *    is an orthogonal concern the caller should own.
 *
 * 3. No floats are used for token accounting. Tokens are integer counts and
 *    time is an integer (milliseconds). This makes comparisons exact.
 */

/**
 * A shared retry budget. Construct one per failing dependency (or per global
 * outbound call surface) and share it across all callers of that dependency.
 */
export class RetryBudget {
  /**
   * @param {object} opts
   * @param {number} opts.maxTokens - Maximum tokens in the bucket. Must be >= 0.
   * @param {number} opts.refillIntervalMs - Add one token every this many ms. Must be >= 0.
   *   0 means "refill is effectively instantaneous between calls" — useful for tests only.
   * @param {number} opts.initialTokens - Tokens at construction. Defaults to maxTokens.
   * @param {() => number} [opts.clock] - Function returning current time in ms. Defaults to Date.now.
   *   Inject a fake in tests; never assert on wall-clock time.
   */
  constructor({ maxTokens, refillIntervalMs, initialTokens, clock }) {
    if (!Number.isInteger(maxTokens) || maxTokens < 0) {
      throw new Error(`maxTokens must be a non-negative integer, got ${maxTokens}`);
    }
    if (!Number.isInteger(refillIntervalMs) || refillIntervalMs < 0) {
      throw new Error(
        `refillIntervalMs must be a non-negative integer, got ${refillIntervalMs}`
      );
    }
    const initial = initialTokens === undefined ? maxTokens : initialTokens;
    if (!Number.isInteger(initial) || initial < 0) {
      throw new Error(`initialTokens must be a non-negative integer, got ${initial}`);
    }
    if (initial > maxTokens) {
      throw new Error(
        `initialTokens (${initial}) cannot exceed maxTokens (${maxTokens})`
      );
    }

    this._maxTokens = maxTokens;
    this._refillIntervalMs = refillIntervalMs;
    this._tokens = initial;
    this._clock = clock ?? Date.now;
    this._lastRefillMs = this._clock();
    this._totalAllowed = 0;
    this._totalDenied = 0;
    this._closed = false;
  }

  /** Current token count, after applying any pending refill. */
  get tokens() {
    this._refill();
    return this._tokens;
  }

  /** Total retry attempts allowed since construction. */
  get totalAllowed() {
    return this._totalAllowed;
  }

  /** Total retry attempts denied since construction. */
  get totalDenied() {
    return this._totalDenied;
  }

  /**
   * Lazily refill tokens based on elapsed time. Called internally before
   * any read or write of _tokens so the bucket is always settled.
   *
   * Refill rule: every refillIntervalMs that has passed, add one token.
   * A zero refillIntervalMs short-circuits to "no time-based refill" because
   * division by zero is undefined; we treat that config as "refill disabled".
   */
  _refill() {
    if (this._refillIntervalMs === 0) {
      return;
    }
    const now = this._clock();
    const elapsed = now - this._lastRefillMs;
    if (elapsed < this._refillIntervalMs) {
      return;
    }
    const intervals = Math.floor(elapsed / this._refillIntervalMs);
    // Advance lastRefillMs by exactly the consumed intervals so partial
    // progress toward the next token is preserved across calls.
    this._lastRefillMs += intervals * this._refillIntervalMs;
    this._tokens = Math.min(this._maxTokens, this._tokens + intervals);
  }

  /**
   * Attempt to reserve a retry token. Returns true if a token was consumed,
   * false if the budget is exhausted (or closed). Never throws on exhaustion.
   */
  tryReserve() {
    if (this._closed) {
      this._totalDenied += 1;
      return false;
    }
    this._refill();
    if (this._tokens > 0) {
      this._tokens -= 1;
      this._totalAllowed += 1;
      return true;
    }
    this._totalDenied += 1;
    return false;
  }

  /**
   * Run fn() only if the budget allows a retry. If allowed, the token is
   * consumed BEFORE fn runs (we are throttling attempts, not successes).
   * Returns whatever fn returns; rejects with whatever fn rejects with.
   * If the budget is exhausted or closed, returns the sentinel
   * RETRY_DENIED (a unique non-Promise object) so the caller can distinguish
   * "denied by budget" from "fn ran and returned undefined".
   *
   * Why a sentinel rather than throwing: throwing would conflate budget
   * denial with fn's own failures and force every caller into try/catch.
   * A sentinel is cheap to check and unambiguous.
   */
  async withRetry(fn) {
    if (typeof fn !== 'function') {
      throw new Error('withRetry requires a function argument');
    }
    if (!this.tryReserve()) {
      return RETRY_DENIED;
    }
    return fn();
  }

  /**
   * Close the budget. Subsequent tryReserve / withRetry calls are denied.
   * Useful for circuit-breaking: when a dependency is definitively down,
   * close the budget so retries stop immediately rather than trickle.
   * Idempotent.
   */
  close() {
    this._closed = true;
  }

  /** True if close() has been called. */
  get closed() {
    return this._closed;
  }
}

/**
 * Sentinel returned by withRetry when the budget denied the attempt.
 * Use === for comparison; it is a unique object reference.
 */
export const RETRY_DENIED = Object.freeze({ __retryDenied: true });
