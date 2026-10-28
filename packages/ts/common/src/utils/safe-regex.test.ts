import { describe, expect, it } from "vitest";

import { safeRegexTest } from "./safe-regex";

describe("safeRegexTest", () => {
  describe("valid pattern - match", () => {
    it("returns true when the value matches the pattern", () => {
      expect(safeRegexTest("^hello", "hello world")).toBe(true);
    });

    it("returns true for a digit pattern matching a digit string", () => {
      expect(safeRegexTest("^\\d+$", "12345")).toBe(true);
    });

    it("returns true when flags are supplied and match succeeds", () => {
      expect(safeRegexTest("^hello", "HELLO WORLD", "i")).toBe(true);
    });
  });

  describe("valid pattern - no match", () => {
    it("returns false when the value does not match the pattern", () => {
      expect(safeRegexTest("^hello", "world")).toBe(false);
    });

    it("returns false for a digit pattern with a non-digit string", () => {
      expect(safeRegexTest("^\\d+$", "abc")).toBe(false);
    });
  });

  describe("invalid pattern", () => {
    it("returns null for an invalid regex pattern", () => {
      expect(safeRegexTest("[invalid", "anything")).toBe(null);
    });

    it("returns null for a pattern with an invalid quantifier", () => {
      expect(safeRegexTest("*bad", "anything")).toBe(null);
    });
  });

  describe("empty input", () => {
    it("returns true when an empty string matches the pattern", () => {
      expect(safeRegexTest("^$", "")).toBe(true);
    });

    it("returns false when the pattern does not match an empty string", () => {
      expect(safeRegexTest("^\\d+$", "")).toBe(false);
    });
  });

  describe("empty pattern", () => {
    it("returns true for an empty pattern against any string (always matches)", () => {
      expect(safeRegexTest("", "anything")).toBe(true);
    });

    it("returns true for an empty pattern against an empty string", () => {
      expect(safeRegexTest("", "")).toBe(true);
    });
  });

  describe("RegExp caching", () => {
    it("returns the same result on repeated calls with the same pattern", () => {
      const first = safeRegexTest("^foo", "foobar");
      const second = safeRegexTest("^foo", "foobar");
      expect(first).toBe(true);
      expect(second).toBe(true);
    });

    it("distinguishes patterns with different flags", () => {
      expect(safeRegexTest("^foo", "FOO")).toBe(false);
      expect(safeRegexTest("^foo", "FOO", "i")).toBe(true);
    });

    it("returns a stable result on repeated calls with the global flag", () => {
      // g flag mutates lastIndex on the shared instance; it must be reset each call
      expect(safeRegexTest("foo", "foo", "g")).toBe(true);
      expect(safeRegexTest("foo", "foo", "g")).toBe(true);
    });

    it("returns a stable result on repeated calls with the sticky flag", () => {
      // y flag mutates lastIndex on the shared instance; it must be reset each call
      expect(safeRegexTest("foo", "foo", "y")).toBe(true);
      expect(safeRegexTest("foo", "foo", "y")).toBe(true);
    });
  });
});
