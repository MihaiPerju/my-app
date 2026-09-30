import { describe, expect, it, vi } from "vitest";

import { onlyOnce } from "./only-once";

describe("onlyOnce", () => {
  it("calls the function only once", () => {
    const mockFn = vi.fn(() => "result");
    const wrappedFn = onlyOnce(mockFn);

    wrappedFn();
    wrappedFn();
    wrappedFn();

    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it("returns the original result on first call", () => {
    const mockFn = vi.fn(() => "result");
    const wrappedFn = onlyOnce(mockFn);

    const result = wrappedFn();

    expect(result).toBe("result");
  });

  it("returns undefined on subsequent calls", () => {
    const mockFn = vi.fn(() => "result");
    const wrappedFn = onlyOnce(mockFn);

    wrappedFn(); // First call

    const secondResult = wrappedFn();
    const thirdResult = wrappedFn();

    expect(secondResult).toBeUndefined();
    expect(thirdResult).toBeUndefined();
  });

  it("forwards arguments correctly on first call", () => {
    const mockFn = vi.fn((a: string, b: number) => `${a}-${b}`);
    const wrappedFn = onlyOnce(mockFn);

    wrappedFn("hello", 42);

    expect(mockFn).toHaveBeenCalledWith("hello", 42);
  });

  it("works with functions that have no parameters", () => {
    const mockFn = vi.fn(() => "no-params");
    const wrappedFn = onlyOnce(mockFn);

    const firstResult = wrappedFn();
    const secondResult = wrappedFn();

    expect(firstResult).toBe("no-params");
    expect(secondResult).toBeUndefined();
    expect(mockFn).toHaveBeenCalledTimes(1);
    expect(mockFn).toHaveBeenCalledWith();
  });

  it("works with functions that have multiple parameters", () => {
    const mockFn = vi.fn((a: string, b: number, c: boolean) => ({ a, b, c }));
    const wrappedFn = onlyOnce(mockFn);

    const result = wrappedFn("test", 123, true);

    expect(result).toEqual({ a: "test", b: 123, c: true });
    expect(mockFn).toHaveBeenCalledWith("test", 123, true);
  });

  it("works with functions that return undefined", () => {
    const mockFn = vi.fn(() => undefined);
    const wrappedFn = onlyOnce(mockFn);

    const firstResult = wrappedFn();
    const secondResult = wrappedFn();

    expect(firstResult).toBeUndefined();
    expect(secondResult).toBeUndefined();
    expect(mockFn).toHaveBeenCalledTimes(1);
  });

  it("propagates the throw and allows retrying", () => {
    const errorFn = vi.fn(() => {
      throw new Error("Test error");
    });
    const wrappedFn = onlyOnce(errorFn);

    // A throwing invocation does not lock the wrapper.
    expect(() => wrappedFn()).toThrow("Test error");
    expect(() => wrappedFn()).toThrow("Test error");
    expect(errorFn).toHaveBeenCalledTimes(2);
  });

  it("locks after the first successful invocation even if earlier calls threw", () => {
    let attempt = 0;
    const fn = vi.fn(() => {
      attempt++;
      if (attempt === 1) throw new Error("first attempt failed");
      return "success";
    });
    const wrapped = onlyOnce(fn);

    expect(() => wrapped()).toThrow("first attempt failed");
    expect(fn).toHaveBeenCalledTimes(1);

    // Second call retries and succeeds — now the wrapper locks.
    expect(wrapped()).toBe("success");
    expect(fn).toHaveBeenCalledTimes(2);

    // Subsequent calls are no-ops.
    expect(wrapped()).toBeUndefined();
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("maintains separate state for different wrapped functions", () => {
    const mockFn1 = vi.fn(() => "fn1");
    const mockFn2 = vi.fn(() => "fn2");

    const wrappedFn1 = onlyOnce(mockFn1);
    const wrappedFn2 = onlyOnce(mockFn2);

    expect(wrappedFn1()).toBe("fn1");
    expect(wrappedFn2()).toBe("fn2");
    expect(wrappedFn1()).toBeUndefined();
    expect(wrappedFn2()).toBeUndefined();

    expect(mockFn1).toHaveBeenCalledTimes(1);
    expect(mockFn2).toHaveBeenCalledTimes(1);
  });
});
