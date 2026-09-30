/**
 * Jitter strategy applied to the computed backoff delay.
 *
 * - `"none"`: deterministic `baseMs * factor^(attempt-1)`, capped at `capMs`.
 * - `"full"`: uniform random in `[0, delay]`. Best general-purpose default
 *   for reducing thundering-herd retries across many clients.
 * - `"equal"`: `delay/2 + uniform random in [0, delay/2]`. Trades some
 *   jitter spread for a higher minimum wait.
 */
export type BackoffJitter = "none" | "full" | "equal";

export type BackoffOptions = {
  /**
   * Delay applied for the first retry, in ms.
   * @default 500
   */
  baseMs?: number;
  /**
   * Upper bound on the computed delay, in ms.
   * @default 30_000
   */
  capMs?: number;
  /**
   * Exponential growth factor per attempt.
   * @default 2
   */
  factor?: number;
  /**
   * Jitter strategy.
   * @default "full"
   */
  jitter?: BackoffJitter;
};

/**
 * Computes an exponential backoff delay for a given attempt number.
 *
 * `attempt` is 1-based: `1` means "after the first failure". For any value
 * `<= 0` the function returns `0` so callers can unconditionally use the
 * returned delay without branching on the happy path. Delays are truncated to
 * whole milliseconds so they can be passed safely to timer and messaging APIs.
 *
 * @example
 * ```ts
 * // With the defaults, the first few failures produce delays of up to
 * // 500ms, 1s, 2s, 4s, ... capped at 30s, randomized uniformly in [0, delay].
 * const wait = computeBackoffDelay(failureCount);
 * await delay(wait);
 * ```
 */
export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const { baseMs = 500, capMs = 30_000, factor = 2, jitter = "full" } = options;

  if (attempt <= 0) {
    return 0;
  }

  const expo = Math.min(capMs, baseMs * Math.pow(factor, attempt - 1));

  switch (jitter) {
    case "none":
      return Math.floor(expo);
    case "equal":
      return Math.floor(expo / 2 + Math.random() * (expo / 2));
    case "full":
      return Math.floor(Math.random() * expo);
  }
}

export type Backoff = {
  /** Number of consecutive failures recorded so far. */
  readonly attempts: number;
  /** Record a failure and return the delay (ms) before the next attempt. */
  fail: () => number;
  /** Mark the operation as successful; resets attempts to `0`. */
  succeed: () => void;
};

/**
 * A small stateful helper that tracks the number of consecutive failures and
 * produces the next backoff delay on demand.
 *
 * This is a thin convenience wrapper around {@link computeBackoffDelay}.
 * Use it when you want to package the attempt counter alongside the delay
 * computation (e.g. a reconnect loop, a long-lived subscription handler).
 *
 * @example
 * ```ts
 * const backoff = createBackoff({ baseMs: 500, capMs: 30_000 });
 *
 * function onError() {
 *   const wait = backoff.fail();
 *   setTimeout(reconnect, wait);
 * }
 *
 * function onData() {
 *   backoff.succeed();
 * }
 * ```
 */
export function createBackoff(options: BackoffOptions = {}): Backoff {
  let attempts = 0;
  return {
    get attempts() {
      return attempts;
    },
    fail: () => {
      attempts += 1;
      return computeBackoffDelay(attempts, options);
    },
    succeed: () => {
      attempts = 0;
    },
  };
}
