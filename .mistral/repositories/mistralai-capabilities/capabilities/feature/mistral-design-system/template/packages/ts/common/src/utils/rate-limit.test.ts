import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { parseRateLimitHeaders } from "./rate-limit";

// Pin "now" so reset/HTTP-date math is deterministic across test runs.
const NOW_EPOCH_SECONDS = 1_700_000_000; // 2023-11-14T22:13:20Z

const FUTURE_HTTP_DATE = new Date(
  (NOW_EPOCH_SECONDS + 45) * 1000,
).toUTCString();
const PAST_HTTP_DATE = new Date((NOW_EPOCH_SECONDS - 60) * 1000).toUTCString();
const FUTURE_EPOCH = String(NOW_EPOCH_SECONDS + 90);
const PAST_EPOCH = String(NOW_EPOCH_SECONDS - 60);

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW_EPOCH_SECONDS * 1000);
});

afterEach(() => {
  vi.useRealTimers();
});

interface Case<T> {
  name: string;
  headers: Record<string, string>;
  expected: T;
}

describe("parseRateLimitHeaders", () => {
  describe("retryAfterSeconds", () => {
    const cases: Case<number | null>[] = [
      // --- No source ---
      { name: "no headers → null", headers: {}, expected: null },
      {
        name: "only unrelated headers → null",
        headers: { "content-type": "application/json", "x-other": "1" },
        expected: null,
      },

      // --- Standard Retry-After ---
      {
        name: "Retry-After delta-seconds",
        headers: { "retry-after": "30" },
        expected: 30,
      },
      {
        name: "Retry-After delta-seconds with whitespace",
        headers: { "retry-after": " 30 " },
        expected: 30,
      },
      {
        name: "Retry-After empty value is ignored",
        headers: { "retry-after": " " },
        expected: null,
      },
      {
        name: "Retry-After HTTP-date in the future → delta",
        headers: { "retry-after": FUTURE_HTTP_DATE },
        expected: 45,
      },
      {
        name: "Retry-After HTTP-date in the past → clamped to 0",
        headers: { "retry-after": PAST_HTTP_DATE },
        expected: 0,
      },
      {
        name: "Retry-After unparseable → null",
        headers: { "retry-after": "not-a-date" },
        expected: null,
      },
      {
        name: "Retry-After fractional seconds → rounded up",
        headers: { "retry-after": "0.2" },
        expected: 1,
      },

      // --- Bucket reset, single bucket, no suffix ---
      {
        name: "x-ratelimit-reset small value treated as delta",
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "30",
        },
        expected: 30,
      },
      {
        name: "x-ratelimit-reset with whitespace",
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": " 30 ",
        },
        expected: 30,
      },
      {
        name: "x-ratelimit-reset empty value is ignored",
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": " ",
        },
        expected: null,
      },
      {
        name: "x-ratelimit-reset large value treated as epoch → delta",
        headers: {
          "x-ratelimit-limit": "10",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": FUTURE_EPOCH,
        },
        expected: 90,
      },
      {
        name: "x-ratelimit-reset past epoch → clamped to 0",
        headers: {
          "x-ratelimit-limit": "10",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": PAST_EPOCH,
        },
        expected: 0,
      },
      {
        name: "ratelimit-reset (no x prefix)",
        headers: {
          "ratelimit-limit": "100",
          "ratelimit-remaining": "0",
          "ratelimit-reset": "12",
        },
        expected: 12,
      },
      {
        name: "case-insensitive header names",
        headers: {
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "5",
        },
        expected: 5,
      },
      {
        name: "only limit, no reset → null",
        headers: { "x-ratelimit-limit": "60" },
        expected: null,
      },
      {
        name: "non-numeric reset → null",
        headers: { "x-ratelimit-reset": "xyz" },
        expected: null,
      },

      // --- Suffixed buckets ---
      {
        name: "single-segment suffix bucket",
        headers: {
          "x-ratelimit-limit-workflow-execution-second": "5",
          "x-ratelimit-remaining-workflow-execution-second": "0",
          "x-ratelimit-reset-workflow-execution-second": "1",
        },
        expected: 1,
      },
      {
        name: "multi-segment suffix (5-minute)",
        headers: {
          "x-ratelimit-limit-workflow-execution-5-minute": "100",
          "x-ratelimit-remaining-workflow-execution-5-minute": "0",
          "x-ratelimit-reset-workflow-execution-5-minute": "120",
        },
        expected: 120,
      },

      // --- Multiple buckets ---
      {
        name: "picks the exhausted bucket over those still having budget",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "3",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-limit-foo-minute": "100",
          "x-ratelimit-remaining-foo-minute": "0",
          "x-ratelimit-reset-foo-minute": "45",
        },
        expected: 45,
      },
      {
        name: "among multiple exhausted buckets, picks the longest reset",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "0",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-limit-foo-hour": "1000",
          "x-ratelimit-remaining-foo-hour": "0",
          "x-ratelimit-reset-foo-hour": "3600",
        },
        expected: 3600,
      },
      {
        name: "without remaining info, falls back to the longest reset",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-limit-foo-hour": "1000",
          "x-ratelimit-reset-foo-hour": "3600",
        },
        expected: 3600,
      },
      {
        name: "suffixed and unsuffixed buckets are distinct",
        headers: {
          "x-ratelimit-limit-foo": "5",
          "x-ratelimit-remaining-foo": "3",
          "x-ratelimit-reset-foo": "1",
          "x-ratelimit-limit": "200",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "60",
        },
        expected: 60,
      },

      // --- Precedence ---
      {
        name: "Retry-After wins over a longer bucket reset",
        headers: {
          "retry-after": "10",
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "300",
        },
        expected: 10,
      },
    ];

    it.each(cases)("$name", ({ headers, expected }) => {
      expect(
        parseRateLimitHeaders(new Headers(headers)).retryAfterSeconds,
      ).toBe(expected);
    });
  });

  describe("quota", () => {
    const cases: Case<number | null>[] = [
      // --- No source ---
      { name: "no headers → null", headers: {}, expected: null },
      {
        name: "only unrelated headers → null",
        headers: { "content-type": "application/json" },
        expected: null,
      },
      {
        name: "Retry-After only → null (no bucket info)",
        headers: { "retry-after": "30" },
        expected: null,
      },

      // --- Single bucket, no suffix ---
      {
        name: "x-ratelimit-limit",
        headers: { "x-ratelimit-limit": "60" },
        expected: 60,
      },
      {
        name: "x-ratelimit-limit with whitespace",
        headers: { "x-ratelimit-limit": " 60 " },
        expected: 60,
      },
      {
        name: "x-ratelimit-limit empty value → null",
        headers: { "x-ratelimit-limit": " " },
        expected: null,
      },
      {
        name: "ratelimit-limit (no x prefix)",
        headers: { "ratelimit-limit": "100" },
        expected: 100,
      },
      {
        name: "case-insensitive header names",
        headers: { "X-RateLimit-Limit": "60" },
        expected: 60,
      },
      {
        name: "limit reported even without reset",
        headers: { "x-ratelimit-limit": "60", "x-ratelimit-remaining": "0" },
        expected: 60,
      },
      {
        name: "non-numeric limit → null",
        headers: { "x-ratelimit-limit": "abc" },
        expected: null,
      },

      // --- Suffixed buckets ---
      {
        name: "single-segment suffix bucket",
        headers: {
          "x-ratelimit-limit-workflow-execution-second": "5",
          "x-ratelimit-remaining-workflow-execution-second": "0",
          "x-ratelimit-reset-workflow-execution-second": "1",
        },
        expected: 5,
      },
      {
        name: "multi-segment suffix (5-minute)",
        headers: {
          "x-ratelimit-limit-workflow-execution-5-minute": "100",
          "x-ratelimit-remaining-workflow-execution-5-minute": "0",
          "x-ratelimit-reset-workflow-execution-5-minute": "120",
        },
        expected: 100,
      },

      // --- Multiple buckets ---
      {
        name: "picks the exhausted bucket's limit over those still having budget",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "3",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-limit-foo-minute": "100",
          "x-ratelimit-remaining-foo-minute": "0",
          "x-ratelimit-reset-foo-minute": "45",
        },
        expected: 100,
      },
      {
        name: "among multiple exhausted buckets, picks the longest-reset bucket's limit",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "0",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-limit-foo-hour": "1000",
          "x-ratelimit-remaining-foo-hour": "0",
          "x-ratelimit-reset-foo-hour": "3600",
        },
        expected: 1000,
      },
      {
        name: "without remaining info, falls back to longest-reset bucket's limit",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-limit-foo-hour": "1000",
          "x-ratelimit-reset-foo-hour": "3600",
        },
        expected: 1000,
      },
      {
        name: "suffixed and unsuffixed buckets are distinct",
        headers: {
          "x-ratelimit-limit-foo": "5",
          "x-ratelimit-remaining-foo": "3",
          "x-ratelimit-reset-foo": "1",
          "x-ratelimit-limit": "200",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "60",
        },
        expected: 200,
      },

      // --- IETF draft limit syntax ---
      {
        name: "IETF draft `60;w=3600` → leading integer",
        headers: { "ratelimit-limit": "60;w=3600" },
        expected: 60,
      },
      {
        name: "IETF draft comma-separated → leading integer",
        headers: { "ratelimit-limit": "60, 100" },
        expected: 60,
      },

      // --- Precedence ---
      {
        name: "Retry-After does not displace bucket quota",
        headers: {
          "retry-after": "10",
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
        },
        expected: 60,
      },
    ];

    it.each(cases)("$name", ({ headers, expected }) => {
      expect(parseRateLimitHeaders(new Headers(headers)).quota).toBe(expected);
    });
  });

  describe("windowSeconds", () => {
    const cases: Case<number | null>[] = [
      // --- No source ---
      { name: "no headers → null", headers: {}, expected: null },
      {
        name: "limit only without window header → null",
        headers: { "x-ratelimit-limit": "60" },
        expected: null,
      },
      {
        name: "Retry-After only → null",
        headers: { "retry-after": "30" },
        expected: null,
      },

      // --- Single bucket, no suffix ---
      {
        name: "x-ratelimit-window",
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-window": "60",
        },
        expected: 60,
      },
      {
        name: "x-ratelimit-window with whitespace",
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-window": " 60 ",
        },
        expected: 60,
      },
      {
        name: "x-ratelimit-window empty value → null",
        headers: {
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-window": " ",
        },
        expected: null,
      },
      {
        name: "ratelimit-window (no x prefix)",
        headers: {
          "ratelimit-limit": "100",
          "ratelimit-remaining": "0",
          "ratelimit-window": "3600",
        },
        expected: 3600,
      },
      {
        name: "case-insensitive header names",
        headers: {
          "X-RateLimit-Limit": "60",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Window": "300",
        },
        expected: 300,
      },
      {
        name: "non-numeric window → null",
        headers: { "x-ratelimit-window": "abc" },
        expected: null,
      },

      // --- Suffixed buckets ---
      {
        name: "single-segment suffix bucket",
        headers: {
          "x-ratelimit-limit-workflow-execution-second": "5",
          "x-ratelimit-remaining-workflow-execution-second": "0",
          "x-ratelimit-reset-workflow-execution-second": "1",
          "x-ratelimit-window-workflow-execution-second": "1",
        },
        expected: 1,
      },
      {
        name: "multi-segment suffix (5-minute)",
        headers: {
          "x-ratelimit-limit-workflow-execution-5-minute": "100",
          "x-ratelimit-remaining-workflow-execution-5-minute": "0",
          "x-ratelimit-reset-workflow-execution-5-minute": "120",
          "x-ratelimit-window-workflow-execution-5-minute": "300",
        },
        expected: 300,
      },

      // --- Multiple buckets ---
      {
        name: "picks the exhausted bucket's window over those still having budget",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "3",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-window-foo-second": "1",
          "x-ratelimit-limit-foo-minute": "100",
          "x-ratelimit-remaining-foo-minute": "0",
          "x-ratelimit-reset-foo-minute": "45",
          "x-ratelimit-window-foo-minute": "60",
        },
        expected: 60,
      },
      {
        name: "among multiple exhausted buckets, picks the longest-reset bucket's window",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "0",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-window-foo-second": "1",
          "x-ratelimit-limit-foo-hour": "1000",
          "x-ratelimit-remaining-foo-hour": "0",
          "x-ratelimit-reset-foo-hour": "3600",
          "x-ratelimit-window-foo-hour": "3600",
        },
        expected: 3600,
      },
      {
        name: "without remaining info, falls back to longest-reset bucket's window",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-window-foo-second": "1",
          "x-ratelimit-limit-foo-hour": "1000",
          "x-ratelimit-reset-foo-hour": "3600",
          "x-ratelimit-window-foo-hour": "3600",
        },
        expected: 3600,
      },
      {
        name: "blocking bucket without window header → null even if other bucket has one",
        headers: {
          "x-ratelimit-limit-foo-second": "5",
          "x-ratelimit-remaining-foo-second": "3",
          "x-ratelimit-reset-foo-second": "1",
          "x-ratelimit-window-foo-second": "1",
          "x-ratelimit-limit-foo-minute": "100",
          "x-ratelimit-remaining-foo-minute": "0",
          "x-ratelimit-reset-foo-minute": "45",
          // no window for the blocking bucket
        },
        expected: null,
      },
      {
        name: "suffixed and unsuffixed buckets are distinct",
        headers: {
          "x-ratelimit-limit-foo": "5",
          "x-ratelimit-remaining-foo": "3",
          "x-ratelimit-reset-foo": "1",
          "x-ratelimit-window-foo": "1",
          "x-ratelimit-limit": "200",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-reset": "60",
          "x-ratelimit-window": "3600",
        },
        expected: 3600,
      },

      // --- Precedence ---
      {
        name: "Retry-After does not displace bucket window",
        headers: {
          "retry-after": "10",
          "x-ratelimit-limit": "60",
          "x-ratelimit-remaining": "0",
          "x-ratelimit-window": "60",
        },
        expected: 60,
      },
    ];

    it.each(cases)("$name", ({ headers, expected }) => {
      expect(parseRateLimitHeaders(new Headers(headers)).windowSeconds).toBe(
        expected,
      );
    });
  });
});
