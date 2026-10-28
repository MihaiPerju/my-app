import { describe, expect, it } from "vitest";

import { noop } from "./noop";

describe("noop", () => {
  it("returns undefined", () => {
    expect(noop()).toBeUndefined();
  });

  it("can be used as a default callback", () => {
    function processData(data: unknown, onComplete = noop) {
      onComplete();
      return data;
    }

    expect(processData("test")).toBe("test");
  });

  it("can be assigned to a variable", () => {
    const callback = noop;
    expect(callback()).toBeUndefined();
  });

  it("can be passed as a function parameter", () => {
    function executeCallback(fn: () => void) {
      fn();
    }

    expect(() => executeCallback(noop)).not.toThrow();
  });
});
