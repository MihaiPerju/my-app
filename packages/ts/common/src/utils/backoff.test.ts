import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { computeBackoffDelay, createBackoff } from "./backoff";

describe("computeBackoffDelay", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("with jitter: 'none'", () => {
    it("returns 0 for attempt <= 0", () => {
      expect(computeBackoffDelay(0, { jitter: "none" })).toBe(0);
      expect(computeBackoffDelay(-1, { jitter: "none" })).toBe(0);
      expect(computeBackoffDelay(-100, { jitter: "none" })).toBe(0);
    });

    it("grows exponentially from the base delay", () => {
      const options = {
        baseMs: 500,
        capMs: 30_000,
        factor: 2,
        jitter: "none",
      } as const;

      expect(computeBackoffDelay(1, options)).toBe(500);
      expect(computeBackoffDelay(2, options)).toBe(1000);
      expect(computeBackoffDelay(3, options)).toBe(2000);
      expect(computeBackoffDelay(4, options)).toBe(4000);
      expect(computeBackoffDelay(5, options)).toBe(8000);
    });

    it("caps the delay at capMs", () => {
      const options = {
        baseMs: 500,
        capMs: 30_000,
        factor: 2,
        jitter: "none",
      } as const;

      expect(computeBackoffDelay(10, options)).toBe(30_000);
      expect(computeBackoffDelay(100, options)).toBe(30_000);
      expect(computeBackoffDelay(1000, options)).toBe(30_000);
    });

    it("honors a custom factor", () => {
      const options = {
        baseMs: 100,
        capMs: 10_000,
        factor: 3,
        jitter: "none",
      } as const;

      expect(computeBackoffDelay(1, options)).toBe(100);
      expect(computeBackoffDelay(2, options)).toBe(300);
      expect(computeBackoffDelay(3, options)).toBe(900);
      expect(computeBackoffDelay(4, options)).toBe(2700);
    });

    it("uses sensible defaults when only jitter is provided", () => {
      expect(computeBackoffDelay(1, { jitter: "none" })).toBe(500);
      expect(computeBackoffDelay(2, { jitter: "none" })).toBe(1000);
      expect(computeBackoffDelay(20, { jitter: "none" })).toBe(30_000);
    });

    it("returns whole milliseconds", () => {
      expect(computeBackoffDelay(1, { baseMs: 100.5, jitter: "none" })).toBe(
        100,
      );
    });
  });

  describe("with jitter: 'full'", () => {
    beforeEach(() => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
    });

    it("returns Math.random() * expo", () => {
      const options = {
        baseMs: 500,
        capMs: 30_000,
        factor: 2,
        jitter: "full",
      } as const;

      expect(computeBackoffDelay(1, options)).toBe(250);
      expect(computeBackoffDelay(2, options)).toBe(500);
      expect(computeBackoffDelay(3, options)).toBe(1000);
    });

    it("respects the cap on the unjittered value", () => {
      const options = {
        baseMs: 500,
        capMs: 30_000,
        factor: 2,
        jitter: "full",
      } as const;

      expect(computeBackoffDelay(100, options)).toBe(15_000);
    });

    it("stays within [0, expo] for any Math.random() output", () => {
      const options = {
        baseMs: 500,
        capMs: 30_000,
        factor: 2,
        jitter: "full",
      } as const;

      for (const sample of [0, 0.25, 0.5, 0.75, 0.999999]) {
        vi.spyOn(Math, "random").mockReturnValue(sample);
        const delay = computeBackoffDelay(4, options);
        expect(delay).toBeGreaterThanOrEqual(0);
        expect(delay).toBeLessThanOrEqual(4000);
      }
    });

    it("is the default jitter strategy", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.5);
      expect(computeBackoffDelay(1, { baseMs: 1000, capMs: 10_000 })).toBe(500);
    });

    it("returns whole milliseconds", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.123456789123);

      expect(computeBackoffDelay(1, { baseMs: 500 })).toBe(61);
    });
  });

  describe("with jitter: 'equal'", () => {
    it("returns expo/2 + random in [0, expo/2]", () => {
      vi.spyOn(Math, "random").mockReturnValue(0);
      expect(
        computeBackoffDelay(1, {
          baseMs: 1000,
          capMs: 30_000,
          factor: 2,
          jitter: "equal",
        }),
      ).toBe(500);

      vi.spyOn(Math, "random").mockReturnValue(0.5);
      expect(
        computeBackoffDelay(1, {
          baseMs: 1000,
          capMs: 30_000,
          factor: 2,
          jitter: "equal",
        }),
      ).toBe(750);

      vi.spyOn(Math, "random").mockReturnValue(0.999999);
      const delay = computeBackoffDelay(1, {
        baseMs: 1000,
        capMs: 30_000,
        factor: 2,
        jitter: "equal",
      });
      expect(delay).toBeGreaterThanOrEqual(500);
      expect(delay).toBeLessThanOrEqual(1000);
    });

    it("stays within [expo/2, expo] for any Math.random() output", () => {
      const options = {
        baseMs: 500,
        capMs: 30_000,
        factor: 2,
        jitter: "equal",
      } as const;

      for (const sample of [0, 0.25, 0.5, 0.75, 0.999999]) {
        vi.spyOn(Math, "random").mockReturnValue(sample);
        const delay = computeBackoffDelay(3, options);
        expect(delay).toBeGreaterThanOrEqual(1000);
        expect(delay).toBeLessThanOrEqual(2000);
      }
    });

    it("returns whole milliseconds", () => {
      vi.spyOn(Math, "random").mockReturnValue(0.123456789123);

      expect(computeBackoffDelay(1, { baseMs: 500, jitter: "equal" })).toBe(
        280,
      );
    });
  });
});

describe("createBackoff", () => {
  it("starts with attempts at 0", () => {
    const backoff = createBackoff({ jitter: "none" });
    expect(backoff.attempts).toBe(0);
  });

  it("increments attempts on fail and returns the matching delay", () => {
    const backoff = createBackoff({
      baseMs: 100,
      capMs: 10_000,
      factor: 2,
      jitter: "none",
    });

    expect(backoff.fail()).toBe(100);
    expect(backoff.attempts).toBe(1);

    expect(backoff.fail()).toBe(200);
    expect(backoff.attempts).toBe(2);

    expect(backoff.fail()).toBe(400);
    expect(backoff.attempts).toBe(3);
  });

  it("resets attempts on succeed", () => {
    const backoff = createBackoff({
      baseMs: 100,
      capMs: 10_000,
      factor: 2,
      jitter: "none",
    });

    backoff.fail();
    backoff.fail();
    backoff.fail();
    expect(backoff.attempts).toBe(3);

    backoff.succeed();
    expect(backoff.attempts).toBe(0);

    expect(backoff.fail()).toBe(100);
    expect(backoff.attempts).toBe(1);
  });

  it("caps delays produced by fail()", () => {
    const backoff = createBackoff({
      baseMs: 100,
      capMs: 500,
      factor: 2,
      jitter: "none",
    });

    expect(backoff.fail()).toBe(100);
    expect(backoff.fail()).toBe(200);
    expect(backoff.fail()).toBe(400);
    expect(backoff.fail()).toBe(500);
    expect(backoff.fail()).toBe(500);
  });
});
