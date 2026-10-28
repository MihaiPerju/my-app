import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  delay,
  oneAtATime,
  serializePromises,
  singleInFlight,
  TimeoutError,
  withTimeout,
  withTimeoutResult,
} from "./promises";

describe("promises utilities", () => {
  beforeEach(() => {
    vi.useFakeTimers().setSystemTime(new Date("2021-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("delay", () => {
    it("resolves after the specified number of milliseconds", async () => {
      const delayPromise = delay(100);

      // Fast-forward time by 100ms
      vi.advanceTimersByTime(100);

      await expect(delayPromise).resolves.toBeUndefined();
    });

    it("works with different delay values", async () => {
      const delays = [10, 50, 200];

      for (const delayMs of delays) {
        const delayPromise = delay(delayMs);

        // Fast-forward time by the delay amount
        vi.advanceTimersByTime(delayMs);

        await expect(delayPromise).resolves.toBeUndefined();
      }
    });

    it("does not resolve before the specified time", async () => {
      const delayPromise = delay(100);

      // Advance by less than the delay
      vi.advanceTimersByTime(50);

      // Promise should still be pending
      expect(vi.getTimerCount()).toBeGreaterThan(0);

      // Advance the remaining time
      vi.advanceTimersByTime(50);

      await expect(delayPromise).resolves.toBeUndefined();
    });
  });

  describe("withTimeout", () => {
    it("returns the result of the promise when it resolves within timeout", async () => {
      const fastPromise = Promise.resolve("success");

      const result = await withTimeout(1000, fastPromise);

      expect(result).toBe("success");
    });

    it("throws TimeoutError when the promise takes longer than timeout", async () => {
      const slowPromise = delay(200).then(() => "slow result");
      const timeoutPromise = withTimeout(50, slowPromise);

      // Advance time to trigger timeout
      vi.advanceTimersByTime(50);

      await expect(timeoutPromise).rejects.toThrow(TimeoutError);
      await expect(timeoutPromise).rejects.toThrow(
        "Promise timed out after 50ms",
      );
    });

    it("preserves the return type of the promise", async () => {
      const numberPromise = Promise.resolve(42);

      const result = await withTimeout(1000, numberPromise);
      expect(typeof result).toBe("number");
      expect(result).toBe(42);
    });

    it("handles promises that reject", async () => {
      const rejectingPromise = Promise.reject(new Error("original error"));

      await expect(withTimeout(1000, rejectingPromise)).rejects.toThrow(
        "original error",
      );
    });

    it("timeouts even if the original promise eventually resolves", async () => {
      const slowPromise = delay(200).then(() => "eventually resolved");
      const timeoutPromise = withTimeout(50, slowPromise);

      // Advance time to trigger timeout before the promise resolves
      vi.advanceTimersByTime(50);

      await expect(timeoutPromise).rejects.toThrow(TimeoutError);
    });

    it("works with promises that resolve immediately", async () => {
      const immediatePromise = Promise.resolve("immediate result");

      const result = await withTimeout(1000, immediatePromise);
      expect(result).toBe("immediate result");
    });

    it("handles different timeout values correctly", async () => {
      const fastPromise = delay(10).then(() => "fast");
      const slowPromise = delay(100).then(() => "slow");

      const fastTimeoutPromise = withTimeout(50, fastPromise);
      const slowTimeoutPromise = withTimeout(50, slowPromise);

      // Advance time to let fast promise resolve
      vi.advanceTimersByTime(10);
      await expect(fastTimeoutPromise).resolves.toBe("fast");

      // Advance time to trigger timeout for slow promise
      vi.advanceTimersByTime(40); // 40 more ms = 50ms total
      await expect(slowTimeoutPromise).rejects.toThrow(TimeoutError);
    });

    it("works with promises that resolve to different data types", async () => {
      const stringPromise = Promise.resolve("string");
      const numberPromise = Promise.resolve(123);
      const booleanPromise = Promise.resolve(true);
      const objectPromise = Promise.resolve({ key: "value" });
      const arrayPromise = Promise.resolve([1, 2, 3]);

      await expect(withTimeout(100, stringPromise)).resolves.toBe("string");
      await expect(withTimeout(100, numberPromise)).resolves.toBe(123);
      await expect(withTimeout(100, booleanPromise)).resolves.toBe(true);
      await expect(withTimeout(100, objectPromise)).resolves.toEqual({
        key: "value",
      });
      await expect(withTimeout(100, arrayPromise)).resolves.toEqual([1, 2, 3]);
    });

    it("resolves promise before timeout is reached", async () => {
      const fastPromise = delay(30).then(() => "resolved");
      const timeoutPromise = withTimeout(100, fastPromise);

      // Advance time to let promise resolve before timeout
      vi.advanceTimersByTime(30);

      await expect(timeoutPromise).resolves.toBe("resolved");
    });

    it("aborts the controller when timeout occurs", async () => {
      const controller = new AbortController();
      const slowPromise = delay(200).then(() => "slow result");
      const timeoutPromise = withTimeout(50, slowPromise, controller);

      expect(controller.signal.aborted).toBe(false);

      // Advance time to trigger timeout
      vi.advanceTimersByTime(50);

      await expect(timeoutPromise).rejects.toThrow(TimeoutError);
      expect(controller.signal.aborted).toBe(true);
    });

    it("does not abort the controller when promise resolves before timeout", async () => {
      const controller = new AbortController();
      const fastPromise = delay(30).then(() => "fast result");
      const timeoutPromise = withTimeout(100, fastPromise, controller);

      // Advance time to let promise resolve
      vi.advanceTimersByTime(30);

      await expect(timeoutPromise).resolves.toBe("fast result");
      expect(controller.signal.aborted).toBe(false);
    });

    it("clears the timeout when the promise resolves before timeout", async () => {
      const fastPromise = delay(30).then(() => "fast");
      const timeoutPromise = withTimeout(100, fastPromise);

      vi.advanceTimersByTime(30);
      await expect(timeoutPromise).resolves.toBe("fast");

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  describe("withTimeoutResult", () => {
    it("returns a completed result when the wrapped function resolves in time", async () => {
      const timed = withTimeoutResult(100, async (_context, value: string) => {
        await delay(10);
        return value.toUpperCase();
      });

      const resultPromise = timed("hello");
      vi.advanceTimersByTime(10);

      await expect(resultPromise).resolves.toEqual({
        status: "completed",
        value: "HELLO",
      });
    });

    it("returns a timed_out result when the wrapped function exceeds the timeout", async () => {
      const timed = withTimeoutResult(50, async () => {
        await delay(200);
        return "slow";
      });

      const resultPromise = timed();
      vi.advanceTimersByTime(50);

      await expect(resultPromise).resolves.toEqual({
        status: "timed_out",
        timeoutMs: 50,
      });
    });

    it("aborts the context controller when the timeout is reached", async () => {
      let abortSignal: AbortSignal | undefined;

      const timed = withTimeoutResult(50, async ({ abortController }) => {
        abortSignal = abortController.signal;
        await delay(200);
        return "slow";
      });

      const resultPromise = timed();
      vi.advanceTimersByTime(50);

      await expect(resultPromise).resolves.toEqual({
        status: "timed_out",
        timeoutMs: 50,
      });
      expect(abortSignal?.aborted).toBe(true);
    });

    it("preserves non-timeout failures as rejections", async () => {
      const timed = withTimeoutResult(100, () =>
        Promise.reject(new Error("original error")),
      );

      await expect(timed()).rejects.toThrow("original error");
    });

    it("clears the timeout when the wrapped function settles early", async () => {
      const completed = withTimeoutResult(100, () => Promise.resolve("done"));
      await expect(completed()).resolves.toEqual({
        status: "completed",
        value: "done",
      });
      expect(vi.getTimerCount()).toBe(0);

      const failed = withTimeoutResult(100, () =>
        Promise.reject(new Error("failed")),
      );
      await expect(failed()).rejects.toThrow("failed");
      expect(vi.getTimerCount()).toBe(0);
    });

    it("observes a late rejection after timing out", async () => {
      const gate = Promise.withResolvers<never>();
      const timed = withTimeoutResult(50, () => gate.promise);
      const resultPromise = timed();

      vi.advanceTimersByTime(50);
      await expect(resultPromise).resolves.toEqual({
        status: "timed_out",
        timeoutMs: 50,
      });

      gate.reject(new Error("late failure"));
      await Promise.resolve();
      await Promise.resolve();

      // Vitest reports unhandled rejections as test failures. Reaching this
      // assertion proves the late rejection stayed observed by the wrapper.
      expect(vi.getTimerCount()).toBe(0);
    });

    it("ignores a late resolution after timing out", async () => {
      const gate = Promise.withResolvers<string>();
      const timed = withTimeoutResult(50, () => gate.promise);
      const resultPromise = timed();

      vi.advanceTimersByTime(50);
      await expect(resultPromise).resolves.toEqual({
        status: "timed_out",
        timeoutMs: 50,
      });

      gate.resolve("late success");
      await Promise.resolve();

      await expect(resultPromise).resolves.toEqual({
        status: "timed_out",
        timeoutMs: 50,
      });
    });
  });

  describe("singleInFlight", () => {
    it("shares the in-flight promise with concurrent callers", async () => {
      const gate = Promise.withResolvers<string>();
      const fn = vi.fn(async (value: string) => {
        const result = await gate.promise;
        return `${value}:${result}`;
      });
      const wrapped = singleInFlight(fn);

      const first = wrapped("first");
      const second = wrapped("second");
      await Promise.resolve();

      expect(first).toBe(second);
      expect(fn).toHaveBeenCalledOnce();

      gate.resolve("done");
      await expect(second).resolves.toBe("first:done");
    });

    it("starts new work after the in-flight promise settles", async () => {
      const fn = vi.fn(async (value: string) => {
        if (value === "first") {
          throw new Error("boom");
        }
        return `${value}-result`;
      });
      const wrapped = singleInFlight(fn);

      await expect(wrapped("first")).rejects.toThrow("boom");
      await expect(wrapped("second")).resolves.toBe("second-result");

      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("serializePromises", () => {
    it("runs calls one after another and returns each call result", async () => {
      const firstGate = Promise.withResolvers<string>();
      const secondGate = Promise.withResolvers<string>();
      const steps: string[] = [];
      const fn = vi.fn(async (value: string) => {
        steps.push(`${value}:start`);
        const result =
          value === "first" ? firstGate.promise : secondGate.promise;
        const resolved = await result;
        steps.push(`${value}:end`);
        return resolved;
      });
      const wrapped = serializePromises(fn);

      const first = wrapped("first");
      const second = wrapped("second");
      await Promise.resolve();

      expect(first).not.toBe(second);
      expect(steps).toEqual(["first:start"]);

      firstGate.resolve("first-result");
      await expect(first).resolves.toBe("first-result");
      await Promise.resolve();
      expect(steps).toEqual(["first:start", "first:end", "second:start"]);

      secondGate.resolve("second-result");
      await expect(second).resolves.toBe("second-result");
      expect(steps).toEqual([
        "first:start",
        "first:end",
        "second:start",
        "second:end",
      ]);
    });

    it("continues running later calls after a rejection", async () => {
      const fn = vi.fn(async (value: string) => {
        if (value === "first") {
          throw new Error("boom");
        }
        return `${value}-result`;
      });
      const wrapped = serializePromises(fn);

      const first = wrapped("first");
      const second = wrapped("second");

      await expect(first).rejects.toThrow("boom");
      await expect(second).resolves.toBe("second-result");
      expect(fn).toHaveBeenCalledTimes(2);
    });
  });

  describe("oneAtATime", () => {
    it("runs the function immediately and returns its result when idle", async () => {
      const fn = vi.fn().mockResolvedValue("result");
      const wrapped = oneAtATime(fn);

      const result = await wrapped("a");

      expect(fn).toHaveBeenCalledTimes(1);
      expect(fn).toHaveBeenCalledWith("a");
      expect(result).toBe("result");
    });

    it("runs sequential calls normally when each completes before the next", async () => {
      const fn = vi
        .fn()
        .mockResolvedValueOnce("r1")
        .mockResolvedValueOnce("r2")
        .mockResolvedValueOnce("r3");
      const wrapped = oneAtATime(fn);

      expect(await wrapped("a")).toBe("r1");
      expect(await wrapped("b")).toBe("r2");
      expect(await wrapped("c")).toBe("r3");
      expect(fn).toHaveBeenCalledTimes(3);
    });

    it("does not call fn a second time while the first call is still running", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      const fn = vi
        .fn()
        .mockReturnValueOnce(d1.promise)
        .mockReturnValueOnce(d2.promise);
      const wrapped = oneAtATime(fn);

      void wrapped("first");
      // fn is called in a microtask, so we need to flush
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      // Second call while first is running
      void wrapped("second");
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      // Resolve both to avoid unhandled rejections
      d1.resolve("done");
      d2.resolve("done2");
    });

    it("queues a second call and executes it after the first completes", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      });
      const wrapped = oneAtATime(fn);

      const p1 = wrapped("first");
      const p2 = wrapped("second");
      // fn is called in a microtask, so we need to flush
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      // Resolve first call
      d1.resolve("result1");
      expect(await p1).toBe("result1");

      // Queued call should now be running
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(2, "second");

      d2.resolve("result2");
      expect(await p2).toBe("result2");
    });

    it("uses the latest args by default when multiple calls are queued", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      });
      const wrapped = oneAtATime(fn);

      const p1 = wrapped("first");
      void wrapped("second");
      void wrapped("third");

      d1.resolve("result1");
      expect(await p1).toBe("result1");

      // Default combineArgs discards previous args and uses latest
      expect(fn).toHaveBeenNthCalledWith(2, "third");

      d2.resolve("result-latest");
    });

    it("all callers during a pending period share the same promise", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      });
      const wrapped = oneAtATime(fn);

      void wrapped("a"); // starts running
      const p2 = wrapped("b"); // enters pending
      const p3 = wrapped("c"); // also pending, same promise
      const p4 = wrapped("d"); // also pending, same promise

      expect(p2).toBe(p3);
      expect(p3).toBe(p4);

      d1.resolve("r1");
      d2.resolve("shared-result");

      expect(await p2).toBe("shared-result");
      expect(await p3).toBe("shared-result");
      expect(await p4).toBe("shared-result");
    });

    it("combines args with a custom combineArgs function", async () => {
      const d1 = Promise.withResolvers<number[]>();
      const d2 = Promise.withResolvers<number[]>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      });
      const combineArgs = vi.fn(
        (prev: [number[]], next: [number[]]): [number[]] => {
          return [[...prev[0], ...next[0]]];
        },
      );
      const wrapped = oneAtATime(fn, combineArgs);

      const p1 = wrapped([1]);
      const p2 = wrapped([2]);
      const p3 = wrapped([3]);

      // fn is called in a microtask, so we need to flush
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);
      expect(combineArgs).toHaveBeenCalledTimes(1);
      expect(combineArgs).toHaveBeenCalledWith([[2]], [[3]]);

      d1.resolve([1]);
      expect(await p1).toEqual([1]);

      // fn should now be called with the combined args
      expect(fn).toHaveBeenCalledTimes(2);
      expect(fn).toHaveBeenNthCalledWith(2, [2, 3]);

      d2.resolve([2, 3]);
      expect(await p2).toEqual([2, 3]);
      expect(await p3).toEqual([2, 3]);
    });

    it("calls combineArgs for each additional pending call", () => {
      const d1 = Promise.withResolvers<string>();
      const fn = vi.fn().mockReturnValueOnce(d1.promise).mockResolvedValue("x");
      const combineArgs = vi.fn((prev: [string], next: [string]): [string] => {
        return [prev[0] + next[0]];
      });
      const wrapped = oneAtATime(fn, combineArgs);

      void wrapped("a"); // running
      void wrapped("b"); // first pending call
      void wrapped("c"); // second pending call — combineArgs("b", "c")
      void wrapped("d"); // third pending call — combineArgs("bc", "d")

      expect(combineArgs).toHaveBeenCalledTimes(2);
      expect(combineArgs).toHaveBeenNthCalledWith(1, ["b"], ["c"]);
      expect(combineArgs).toHaveBeenNthCalledWith(2, ["bc"], ["d"]);

      d1.resolve("done");
    });

    it("propagates errors from the initial call", async () => {
      const fn = vi.fn().mockRejectedValue(new Error("boom"));
      const wrapped = oneAtATime(fn);

      await expect(wrapped("a")).rejects.toThrow("boom");
    });

    it("still runs the queued call after the initial call rejects", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      });
      const wrapped = oneAtATime(fn);

      const p1 = wrapped("first");
      const p2 = wrapped("second");

      d1.reject(new Error("error1"));
      await expect(p1).rejects.toThrow("error1");

      // Queued call should still run
      expect(fn).toHaveBeenCalledTimes(2);

      d2.resolve("result2");
      expect(await p2).toBe("result2");
    });

    it("propagates errors from the queued call to all waiters", async () => {
      const d1 = Promise.withResolvers<string>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return d1.promise;
        return Promise.reject(new Error("queued boom"));
      });
      const wrapped = oneAtATime(fn);

      const p1 = wrapped("first");
      const p2 = wrapped("second");
      const p3 = wrapped("third");

      d1.resolve("result1");
      expect(await p1).toBe("result1");

      await expect(p2).rejects.toThrow("queued boom");
      await expect(p3).rejects.toThrow("queued boom");
    });

    it("returns to idle after all work completes and accepts new calls", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      const d3 = Promise.withResolvers<string>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        if (callCount === 1) return d1.promise;
        if (callCount === 2) return d2.promise;
        return d3.promise;
      });
      const wrapped = oneAtATime(fn);

      // First batch
      const p1 = wrapped("a");
      const p2 = wrapped("b");

      d1.resolve("r1");
      await p1;
      d2.resolve("r2");
      await p2;
      // Flush microtask queue so onFinally runs and sets state to idle
      await Promise.resolve();

      // Should be idle again — new call runs immediately
      const p3 = wrapped("c");
      // fn is called in a microtask, so we need to flush
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(3);

      d3.resolve("r3");
      expect(await p3).toBe("r3");
    });

    it("handles chained pending calls across multiple cycles", async () => {
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      const d3 = Promise.withResolvers<string>();
      const deferreds = [d1, d2, d3];
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        const d = deferreds[callCount];
        callCount++;
        return d?.promise;
      });
      const wrapped = oneAtATime(fn);

      // Start first call
      const p1 = wrapped("a");
      // fn is called in a microtask, so we need to flush
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      // Queue second while first is running
      const p2 = wrapped("b");
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(1);

      // Resolve first → triggers second
      d1.resolve("r1");
      expect(await p1).toBe("r1");
      expect(fn).toHaveBeenCalledTimes(2);

      // Queue third while second is running
      const p3 = wrapped("c");
      expect(fn).toHaveBeenCalledTimes(2);

      // Resolve second → triggers third
      d2.resolve("r2");
      expect(await p2).toBe("r2");
      // Flush microtask queue: one for onFinally, one for the deferred fn call
      await Promise.resolve();
      await Promise.resolve();
      expect(fn).toHaveBeenCalledTimes(3);

      // Resolve third
      d3.resolve("r3");
      expect(await p3).toBe("r3");
    });

    it("does not run the function concurrently", async () => {
      let concurrency = 0;
      let maxConcurrency = 0;
      const d1 = Promise.withResolvers<string>();
      const d2 = Promise.withResolvers<string>();
      const deferreds = [d1, d2];
      let callCount = 0;

      const fn = vi.fn().mockImplementation(() => {
        concurrency++;
        maxConcurrency = Math.max(maxConcurrency, concurrency);
        const d = deferreds[callCount];
        callCount++;
        return d?.promise.finally(() => {
          concurrency--;
        });
      });
      const wrapped = oneAtATime(fn);

      const p1 = wrapped("a");
      const p2 = wrapped("b");
      // p2 and p3 share the same promise since they're both queued while p1 runs
      void wrapped("c");

      d1.resolve("r1");
      await p1;

      d2.resolve("r2");
      await p2;

      expect(maxConcurrency).toBe(1);
      expect(fn).toHaveBeenCalledTimes(2);
    });

    it("returns the correct value for the initial caller even with pending calls", async () => {
      const d1 = Promise.withResolvers<number>();
      const d2 = Promise.withResolvers<number>();
      let callCount = 0;
      const fn = vi.fn().mockImplementation(() => {
        callCount++;
        return callCount === 1 ? d1.promise : d2.promise;
      });
      const wrapped = oneAtATime(fn);

      const p1 = wrapped(1);
      const p2 = wrapped(2);

      d1.resolve(100);
      d2.resolve(200);

      // First caller gets the first result, not the pending result
      expect(await p1).toBe(100);
      expect(await p2).toBe(200);
    });
  });
});
