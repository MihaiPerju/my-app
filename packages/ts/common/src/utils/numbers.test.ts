import { describe, expect, it } from "vitest";

import { isEven, isInteger, isOdd } from "./numbers.js";

describe("isInteger", () => {
  it("returns true for positive integers", () => {
    expect(isInteger(0)).toBe(true);
    expect(isInteger(1)).toBe(true);
    expect(isInteger(2)).toBe(true);
    expect(isInteger(100)).toBe(true);
    expect(isInteger(1000)).toBe(true);
    expect(isInteger(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("returns true for negative integers", () => {
    expect(isInteger(-1)).toBe(true);
    expect(isInteger(-2)).toBe(true);
    expect(isInteger(-100)).toBe(true);
    expect(isInteger(-1000)).toBe(true);
    expect(isInteger(Number.MIN_SAFE_INTEGER)).toBe(true);
  });

  it("returns false for positive decimal numbers", () => {
    expect(isInteger(0.1)).toBe(false);
    expect(isInteger(0.5)).toBe(false);
    expect(isInteger(0.9)).toBe(false);
    expect(isInteger(1.1)).toBe(false);
    expect(isInteger(1.5)).toBe(false);
    expect(isInteger(2.7)).toBe(false);
    expect(isInteger(10.25)).toBe(false);
    expect(isInteger(100.999)).toBe(false);
  });

  it("returns false for negative decimal numbers", () => {
    expect(isInteger(-0.1)).toBe(false);
    expect(isInteger(-0.5)).toBe(false);
    expect(isInteger(-0.9)).toBe(false);
    expect(isInteger(-1.1)).toBe(false);
    expect(isInteger(-1.5)).toBe(false);
    expect(isInteger(-2.7)).toBe(false);
    expect(isInteger(-10.25)).toBe(false);
    expect(isInteger(-100.999)).toBe(false);
  });

  it("returns true for numbers that are mathematically integers but have decimal representation", () => {
    expect(isInteger(2.0)).toBe(true);
    expect(isInteger(-2.0)).toBe(true);
    expect(isInteger(10.0)).toBe(true);
    expect(isInteger(-10.0)).toBe(true);
  });

  it("handles very small decimal numbers", () => {
    expect(isInteger(0.0000001)).toBe(false);
    expect(isInteger(-0.0000001)).toBe(false);
    expect(isInteger(Number.EPSILON)).toBe(false);
    expect(isInteger(-Number.EPSILON)).toBe(false);
  });

  it("handles special floating point values", () => {
    expect(isInteger(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isInteger(Number.NEGATIVE_INFINITY)).toBe(false);
    expect(isInteger(NaN)).toBe(false);
  });

  it("handles edge cases around zero", () => {
    expect(isInteger(0)).toBe(true);
    expect(isInteger(-0)).toBe(true);
    expect(isInteger(+0)).toBe(true);
  });
});

describe("isEven", () => {
  it("returns true for positive even numbers", () => {
    expect(isEven(2)).toBe(true);
    expect(isEven(4)).toBe(true);
    expect(isEven(6)).toBe(true);
    expect(isEven(100)).toBe(true);
    expect(isEven(1000)).toBe(true);
  });

  it("returns true for negative even numbers", () => {
    expect(isEven(-2)).toBe(true);
    expect(isEven(-4)).toBe(true);
    expect(isEven(-6)).toBe(true);
    expect(isEven(-100)).toBe(true);
    expect(isEven(-1000)).toBe(true);
  });

  it("returns false for positive odd numbers", () => {
    expect(isEven(1)).toBe(false);
    expect(isEven(3)).toBe(false);
    expect(isEven(5)).toBe(false);
    expect(isEven(99)).toBe(false);
    expect(isEven(1001)).toBe(false);
  });

  it("returns false for negative odd numbers", () => {
    expect(isEven(-1)).toBe(false);
    expect(isEven(-3)).toBe(false);
    expect(isEven(-5)).toBe(false);
    expect(isEven(-99)).toBe(false);
    expect(isEven(-1001)).toBe(false);
  });

  it("returns true for zero", () => {
    expect(isEven(0)).toBe(true);
  });

  it("throws on decimal numbers", () => {
    expect(() => isEven(2.0)).not.toThrow();
    expect(() => isEven(2.5)).toThrow();
    expect(() => isEven(2.9)).toThrow();
  });

  it("handles very large numbers", () => {
    expect(isEven(Number.MAX_SAFE_INTEGER - 1)).toBe(true);
    expect(isEven(Number.MAX_SAFE_INTEGER)).toBe(false);
  });

  it("handles very small numbers", () => {
    expect(isEven(Number.MIN_SAFE_INTEGER + 1)).toBe(true);
    expect(isEven(Number.MIN_SAFE_INTEGER)).toBe(false);
  });
});

describe("isOdd", () => {
  it("returns true for positive odd numbers", () => {
    expect(isOdd(1)).toBe(true);
    expect(isOdd(3)).toBe(true);
    expect(isOdd(5)).toBe(true);
    expect(isOdd(99)).toBe(true);
    expect(isOdd(1001)).toBe(true);
  });

  it("returns true for negative odd numbers", () => {
    expect(isOdd(-1)).toBe(true);
    expect(isOdd(-3)).toBe(true);
    expect(isOdd(-5)).toBe(true);
    expect(isOdd(-99)).toBe(true);
    expect(isOdd(-1001)).toBe(true);
  });

  it("returns false for positive even numbers", () => {
    expect(isOdd(2)).toBe(false);
    expect(isOdd(4)).toBe(false);
    expect(isOdd(6)).toBe(false);
    expect(isOdd(100)).toBe(false);
    expect(isOdd(1000)).toBe(false);
  });

  it("returns false for negative even numbers", () => {
    expect(isOdd(-2)).toBe(false);
    expect(isOdd(-4)).toBe(false);
    expect(isOdd(-6)).toBe(false);
    expect(isOdd(-100)).toBe(false);
    expect(isOdd(-1000)).toBe(false);
  });

  it("returns false for zero", () => {
    expect(isOdd(0)).toBe(false);
  });

  it("throws on decimal numbers", () => {
    expect(() => isOdd(2.0)).not.toThrow();
    expect(() => isOdd(2.5)).toThrow();
    expect(() => isOdd(2.9)).toThrow();
  });

  it("handles very large numbers", () => {
    expect(isOdd(Number.MAX_SAFE_INTEGER - 1)).toBe(false);
    expect(isOdd(Number.MAX_SAFE_INTEGER)).toBe(true);
  });

  it("handles very small numbers", () => {
    expect(isOdd(Number.MIN_SAFE_INTEGER + 1)).toBe(false);
    expect(isOdd(Number.MIN_SAFE_INTEGER)).toBe(true);
  });
});

describe("isEven and isOdd relationship", () => {
  it("has complementary results for the same number", () => {
    const testNumbers = [0, 1, -1, 2, -2, 3, -3, 100, -100, 999, -999];

    for (const num of testNumbers) {
      expect(isEven(num)).toBe(!isOdd(num));
      expect(isOdd(num)).toBe(!isEven(num));
    }
  });

  it("handles edge cases consistently", () => {
    const edgeCases = [
      Number.MAX_SAFE_INTEGER,
      Number.MIN_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER - 1,
      Number.MIN_SAFE_INTEGER + 1,
    ];

    for (const num of edgeCases) {
      expect(isEven(num)).toBe(!isOdd(num));
      expect(isOdd(num)).toBe(!isEven(num));
    }
  });
});
