export interface RateLimitInfo {
  /**
   * Seconds the client should wait before retrying. `null` when the upstream
   * did not include a parseable `Retry-After` (RFC 6585) or `X-RateLimit-Reset`
   * header.
   */
  retryAfterSeconds: number | null;
  /**
   * The total request quota for the current window, as advertised by the
   * upstream via `RateLimit-Limit` or `X-RateLimit-Limit`. `null` when absent.
   * Useful for UX like "limit of 60 per hour", but never load-bearing — the
   * cooldown is enforced by the upstream regardless.
   */
  quota: number | null;
  /**
   * The duration of the rate-limit window in seconds, as advertised by the
   * upstream via `RateLimit-Window` or `X-RateLimit-Window`. `null` when
   * absent. Lets the UI render "60 per minute" instead of "60 per window".
   */
  windowSeconds: number | null;
}

/**
 * Thrown when an upstream API responds with HTTP 429.
 *
 * Consumers may catch this to surface a typed cooldown and, where available,
 * the quota that was exceeded.
 */
export class RateLimitedError extends Error {
  readonly info: RateLimitInfo;

  constructor(info: RateLimitInfo, options?: ErrorOptions) {
    super("Rate limit exceeded", options);
    this.name = "RateLimitedError";
    this.info = info;
  }
}

/**
 * Best-effort extraction of rate-limit metadata from response headers.
 *
 * `retryAfterSeconds` prefers the standard `Retry-After` header (RFC 6585),
 * supporting both delta-seconds ("30") and HTTP-date forms. Falls back to the
 * `reset` of the bucket the upstream is blocking on (see below).
 *
 * `quota` and `windowSeconds` are taken from the same blocking bucket's
 * `limit` and `window` respectively.
 *
 * Bucket scanning: we accept any combination of
 *   `(x-)?ratelimit-(limit|remaining|reset|window)(-<suffix>)?`
 * and group by `<suffix>`. Some upstreams emit several buckets per response
 * (e.g. one per granularity: per-second, per-minute, per-hour) — we pick the
 * bucket that's actually blocking using `remaining === 0` so the displayed
 * cooldown matches the real wait, and break ties by longest reset to avoid
 * underpromising.
 *
 * `reset` may be either an epoch timestamp (seconds since 1970) or seconds
 * remaining in the window — values larger than ~year 2001 are treated as
 * epoch, smaller as deltas.
 *
 * All fields are `null` when no parseable header is present.
 */
export function parseRateLimitHeaders(headers: Headers): RateLimitInfo {
  const blocking = pickBlockingBucket(headers);
  return {
    retryAfterSeconds: parseRetryAfter(headers) ?? blocking.retryAfterSeconds,
    quota: blocking.quota,
    windowSeconds: blocking.windowSeconds,
  };
}

/**
 * Parse the standard HTTP `Retry-After` header.
 *
 * Per the HTTP spec this is either a delay in seconds (`Retry-After: 30`) or
 * an HTTP-date (`Retry-After: Wed, 21 Oct 2015 07:28:00 GMT`). Both formats
 * are normalized to a delay in seconds. Epoch timestamps are intentionally
 * handled by `resetToDeltaSeconds` for RateLimit-Reset-style headers instead.
 */
function parseRetryAfter(headers: Headers): number | null {
  const retryAfter = headers.get("retry-after");
  if (retryAfter === null) return null;

  const trimmed = retryAfter.trim();
  if (!trimmed) return null;

  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.ceil(asNumber);
  }

  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, Math.ceil((asDate - Date.now()) / 1000));
  }

  return null;
}

interface RateLimitBucket {
  limit?: number;
  remaining?: number;
  reset?: number;
  window?: number;
}

const RATE_LIMIT_HEADER_PATTERN =
  /^(?:x-)?ratelimit-(limit|remaining|reset|window)(?:-(.+))?$/;

function pickBlockingBucket(headers: Headers): RateLimitInfo {
  const buckets = collectBuckets(headers);
  if (buckets.length === 0) {
    return { retryAfterSeconds: null, quota: null, windowSeconds: null };
  }

  // Prefer buckets known to be exhausted (`remaining === 0`); fall back to all
  // buckets when none are flagged. Within the candidate set, take the longest
  // reset so we don't tell the user "retry in 5s" when they actually have to
  // wait an hour for another bucket.
  const exhausted = buckets.filter((b) => b.remaining === 0);
  const candidates = exhausted.length > 0 ? exhausted : buckets;

  const winner = candidates.reduce((best, current) =>
    (current.reset ?? -Infinity) > (best.reset ?? -Infinity) ? current : best,
  );

  return {
    retryAfterSeconds:
      winner.reset !== undefined ? resetToDeltaSeconds(winner.reset) : null,
    quota: winner.limit ?? null,
    windowSeconds: winner.window ?? null,
  };
}

function collectBuckets(headers: Headers): RateLimitBucket[] {
  const bySuffix = new Map<string, RateLimitBucket>();

  headers.forEach((value, name) => {
    const match = RATE_LIMIT_HEADER_PATTERN.exec(name.toLowerCase());
    if (!match) return;

    const [, kind, suffix = ""] = match;
    // Kazekit rate-limit headers use suffixed buckets, e.g.
    // `x-ratelimit-limit-workflow-execution-minute`, so group the limit,
    // remaining, reset and window fields by the suffix after the field name.
    // IETF draft `RateLimit-Limit` may carry a window expression like
    // "60;w=3600" — take the leading integer.
    const trimmed = value.trim();
    if (!trimmed) return;

    const leading = trimmed.split(/[,;\s]/)[0];
    const num = Number(leading);
    if (!Number.isFinite(num)) return;

    const bucket = bySuffix.get(suffix) ?? {};
    bucket[kind as keyof RateLimitBucket] = num;
    bySuffix.set(suffix, bucket);
  });

  return [...bySuffix.values()];
}

function resetToDeltaSeconds(reset: number): number {
  // Heuristic: anything past unix epoch year 2001 is an absolute timestamp;
  // smaller values are deltas already.
  const EPOCH_THRESHOLD_SECONDS = 1_000_000_000;
  if (reset > EPOCH_THRESHOLD_SECONDS) {
    return Math.max(0, Math.ceil(reset - Date.now() / 1000));
  }
  return Math.max(0, Math.ceil(reset));
}
