import { describe, expect, it } from "vitest";

import { isAsyncIterable } from "./iterables";

describe("isAsyncIterable", () => {
  it("returns true for async generators", () => {
    async function* stream() {
      yield 1;
    }

    expect(isAsyncIterable(stream())).toBe(true);
  });

  it("returns true for custom async iterable objects", () => {
    const value = {
      async *[Symbol.asyncIterator]() {
        yield "ok";
      },
    };

    expect(isAsyncIterable(value)).toBe(true);
  });

  it("returns false for sync iterables", () => {
    expect(isAsyncIterable([1, 2, 3])).toBe(false);
  });

  it("returns false for non-iterable values", () => {
    expect(isAsyncIterable(null)).toBe(false);
    expect(isAsyncIterable(undefined)).toBe(false);
    expect(isAsyncIterable(42)).toBe(false);
    expect(isAsyncIterable("hello")).toBe(false);
    expect(isAsyncIterable({})).toBe(false);
  });
});
