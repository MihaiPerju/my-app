import { describe, expect, it } from "vitest";

import { mapTuple } from "./arrays";

describe("mapTuple", () => {
  it("maps over an empty tuple", () => {
    const result = mapTuple([], (x) => x * 2);
    expect(result).toEqual([]);
  });

  it("maps over a single-element tuple", () => {
    const result = mapTuple([5], (x) => x * 2);
    expect(result).toEqual([10]);
  });

  it("maps over a multi-element tuple", () => {
    const result = mapTuple([1, 2, 3], (x) => x * 2);
    expect(result).toEqual([2, 4, 6]);
  });

  it("transforms types correctly", () => {
    const result = mapTuple([1, 2, 3], (x) => String(x));
    expect(result).toEqual(["1", "2", "3"]);
  });

  it("works with objects", () => {
    const input = [
      { id: 1, name: "Alice" },
      { id: 2, name: "Bob" },
    ];
    const result = mapTuple(input, (user) => user.name);
    expect(result).toEqual(["Alice", "Bob"]);
  });

  it("works with complex transformations", () => {
    const result = mapTuple([1, 2, 3], (x) => ({ value: x, doubled: x * 2 }));
    expect(result).toEqual([
      { value: 1, doubled: 2 },
      { value: 2, doubled: 4 },
      { value: 3, doubled: 6 },
    ]);
  });

  it("preserves tuple length", () => {
    const input = [1, 2, 3, 4, 5] as const;
    const result = mapTuple(input, (x) => x + 1);
    expect(result).toHaveLength(5);
    expect(result).toEqual([2, 3, 4, 5, 6]);
  });

  it("works with mixed-type tuples", () => {
    const input = [1, "two", true] as const;
    const result = mapTuple(input, (x) => String(x));
    expect(result).toEqual(["1", "two", "true"]);
  });

  it("handles null and undefined values", () => {
    const input = [1, null, undefined, 4];
    const result = mapTuple(input, (x) => x ?? 0);
    expect(result).toEqual([1, 0, 0, 4]);
  });

  it("works with arrow functions", () => {
    const result = mapTuple([1, 2, 3], (x) => x ** 2);
    expect(result).toEqual([1, 4, 9]);
  });

  it("works with index-based transformations", () => {
    // Note: mapTuple doesn't pass index, but we can test with a stateful function
    let counter = 0;
    const result = mapTuple([10, 20, 30], () => counter++);
    expect(result).toEqual([0, 1, 2]);
  });

  it("handles large tuples", () => {
    const input = Array.from({ length: 100 }, (_, i) => i);
    const result = mapTuple(input, (x) => x * 2);
    const expected = Array.from({ length: 100 }, (_, i) => i * 2);
    expect(result).toEqual(expected);
  });
});
