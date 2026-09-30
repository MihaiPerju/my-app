import { beforeEach, describe, expect, it, vi } from "vitest";

import { withRetryOnCondition } from "./with-retry-on-condition";

describe("withRetryOnCondition", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("resolves immediately when condition is not met", async () => {
    const fn = vi.fn().mockResolvedValue([1, 2, 3]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const result = await withRetryOnCondition(fn, shouldRetry, {
      delayMs: 1000,
    });

    expect(result).toEqual([1, 2, 3]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries until condition is not met", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([42]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, {
      delayMs: 1000,
    });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result).toEqual([42]);
  });

  it("returns last result after maximum number of retries if condition keeps being met", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, { delayMs: 1000 });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(4); // 3 retries + 1 final call
    expect(result).toEqual([]);
  });

  it("respects custom delay between retries", async () => {
    const fn = vi.fn().mockResolvedValueOnce([]).mockResolvedValueOnce([99]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const spy = vi.spyOn(globalThis, "setTimeout");

    const promise = withRetryOnCondition(fn, shouldRetry, {
      delayMs: 500,
    });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(spy).toHaveBeenCalledWith(expect.any(Function), 500);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual([99]);
  });

  it("works with object empty condition", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce({})
      .mockResolvedValueOnce({ foo: "bar" });
    const shouldRetry = (obj: object) => Object.keys(obj).length === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, {
      delayMs: 1000,
    });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ foo: "bar" });
  });

  it("works with string empty condition", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce("")
      .mockResolvedValueOnce("  ")
      .mockResolvedValueOnce("foo");
    const shouldRetry = (str: string) => str.trim() === "";

    const promise = withRetryOnCondition(fn, shouldRetry, {
      delayMs: 1000,
    });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(3);
    expect(result).toBe("foo");
  });

  it("works with number zero condition", async () => {
    const fn = vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(42);
    const shouldRetry = (num: number) => num === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, {
      delayMs: 1000,
    });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(2);
    expect(result).toBe(42);
  });

  it("uses default parameters correctly", async () => {
    const fn = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([1]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, { maxRetries: 4 });

    await vi.runAllTimersAsync();

    const result = await promise;

    expect(fn).toHaveBeenCalledTimes(4);
    expect(result).toEqual([1]);
  });

  it("calls fn exactly once when maxRetries is 0", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, {
      maxRetries: 0,
      delayMs: 1000,
    });

    await vi.runAllTimersAsync();

    await promise;

    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("calls fn exactly 3 times when maxRetries is 2 and condition always holds", async () => {
    const fn = vi.fn().mockResolvedValue([]);
    const shouldRetry = (arr: number[]) => arr.length === 0;

    const promise = withRetryOnCondition(fn, shouldRetry, {
      maxRetries: 2,
      delayMs: 1000,
    });

    await vi.runAllTimersAsync();

    await promise;

    // 2 retries in the loop + 1 final call = 3 total
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("handles function rejection correctly", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Network error"));
    const shouldRetry = (arr: number[]) => arr.length === 0;

    await expect(withRetryOnCondition(fn, shouldRetry)).rejects.toThrow(
      "Network error",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("handles predicate function errors correctly", async () => {
    const fn = vi.fn().mockResolvedValue([1, 2, 3]);
    const shouldRetry = vi.fn().mockImplementation(() => {
      throw new Error("Predicate error");
    });

    await expect(withRetryOnCondition(fn, shouldRetry)).rejects.toThrow(
      "Predicate error",
    );
    expect(fn).toHaveBeenCalledTimes(1);
  });
});
