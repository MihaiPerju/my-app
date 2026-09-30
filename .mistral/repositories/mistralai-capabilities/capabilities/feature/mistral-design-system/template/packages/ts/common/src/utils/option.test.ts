import { describe, expect, it } from "vitest";

import type { Option } from "../types/option";
import { isNone, isSome, none, some } from "./option";

describe("some", () => {
  it("creates a Some with a string value", () => {
    const result = some("hello");
    expect(result).toEqual({ value: "hello" });
  });

  it("creates a Some with a number value", () => {
    const result = some(42);
    expect(result).toEqual({ value: 42 });
  });

  it("creates a Some with a boolean value", () => {
    const result = some(true);
    expect(result).toEqual({ value: true });
  });

  it("creates a Some with null value", () => {
    const result = some(null);
    expect(result).toEqual({ value: null });
  });

  it("creates a Some with undefined value", () => {
    const result = some(undefined);
    expect(result).toEqual({ value: undefined });
  });

  it("creates a Some with an object value", () => {
    const obj = { name: "test", id: 1 };
    const result = some(obj);
    expect(result).toEqual({ value: obj });
    expect(result.value).toBe(obj);
  });

  it("creates a Some with an array value", () => {
    const arr = [1, 2, 3];
    const result = some(arr);
    expect(result).toEqual({ value: arr });
    expect(result.value).toBe(arr);
  });

  it("creates a Some with a nested object", () => {
    const nested = { user: { name: "Alice", age: 30 } };
    const result = some(nested);
    expect(result).toEqual({ value: nested });
  });

  it("creates a Some with a function value", () => {
    const fn = () => "test";
    const result = some(fn);
    expect(result).toEqual({ value: fn });
    expect(result.value).toBe(fn);
  });

  it("creates a Some with zero", () => {
    const result = some(0);
    expect(result).toEqual({ value: 0 });
  });

  it("creates a Some with empty string", () => {
    const result = some("");
    expect(result).toEqual({ value: "" });
  });

  it("creates a Some with empty array", () => {
    const result = some([]);
    expect(result).toEqual({ value: [] });
  });

  it("creates a Some with empty object", () => {
    const result = some({});
    expect(result).toEqual({ value: {} });
  });

  it("preserves reference equality for objects", () => {
    const obj = { data: "test" };
    const result = some(obj);
    expect(result.value).toBe(obj);
  });

  it("works with complex nested structures", () => {
    const complex = {
      users: [
        { id: 1, name: "Alice" },
        { id: 2, name: "Bob" },
      ],
      metadata: {
        count: 2,
        timestamp: new Date("2021-01-01"),
      },
    };
    const result = some(complex);
    expect(result).toEqual({ value: complex });
  });
});

describe("isSome", () => {
  it("returns true for a Some value", () => {
    expect(isSome(some("hello"))).toBe(true);
  });

  it("returns true for a Some wrapping falsy values", () => {
    expect(isSome(some(0))).toBe(true);
    expect(isSome(some(""))).toBe(true);
    expect(isSome(some(false))).toBe(true);
    expect(isSome(some(null))).toBe(true);
  });

  it("returns false for none (null)", () => {
    expect(isSome(none())).toBe(false);
  });

  it("returns false for null directly", () => {
    const opt: Option<string> = null;
    expect(isSome(opt)).toBe(false);
  });
});

describe("isNone", () => {
  it("returns true for none (null)", () => {
    expect(isNone(none())).toBe(true);
  });

  it("returns true for null directly", () => {
    const opt: Option<string> = null;
    expect(isNone(opt)).toBe(true);
  });

  it("returns false for a Some value", () => {
    expect(isNone(some("hello"))).toBe(false);
  });

  it("returns false for a Some wrapping falsy values", () => {
    expect(isNone(some(0))).toBe(false);
    expect(isNone(some(""))).toBe(false);
    expect(isNone(some(false))).toBe(false);
  });
});

describe("none", () => {
  it("returns null", () => {
    const result = none<string>();
    expect(result).toBeNull();
  });

  it("works with different types", () => {
    const stringNone = none<string>();
    const numberNone = none<number>();
    const objectNone = none<{ key: string }>();

    expect(stringNone).toBeNull();
    expect(numberNone).toBeNull();
    expect(objectNone).toBeNull();
  });

  it("is assignable to Option type", () => {
    const result: Option<string> = none();
    expect(result).toBeNull();
  });
});
