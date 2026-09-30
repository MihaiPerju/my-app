import { describe, expect, it } from "vitest";

import { EXACT_MATCH_SCORE, fuzzyMatch, fuzzySearch } from "./fuzzy-search.js";

describe("fuzzyMatch", () => {
  it("returns null when query does not match", () => {
    expect(fuzzyMatch("xyz", "Code Interpreter")).toBeNull();
  });

  it("matches exact substring", () => {
    expect(fuzzyMatch("code", "Code Interpreter")).not.toBeNull();
  });

  it("matches subsequence characters in order", () => {
    expect(fuzzyMatch("cdin", "Code Interpreter")).not.toBeNull();
  });

  it("is case insensitive by default", () => {
    expect(fuzzyMatch("CODE", "code interpreter")).not.toBeNull();
  });

  it("respects case when caseSensitive is true", () => {
    expect(
      fuzzyMatch("CODE", "code interpreter", { caseSensitive: true }),
    ).toBeNull();
    expect(
      fuzzyMatch("code", "code interpreter", { caseSensitive: true }),
    ).not.toBeNull();
  });

  it("scores consecutive matches higher than spread matches", () => {
    const consecutive = fuzzyMatch("code", "Code Interpreter");
    const spread = fuzzyMatch("cdip", "Code Interpreter");
    expect(consecutive).not.toBeNull();
    expect(spread).not.toBeNull();
    if (spread) {
      expect(consecutive).toBeGreaterThan(spread);
    }
  });

  it("returns null for empty text with non-empty query", () => {
    expect(fuzzyMatch("a", "")).toBeNull();
  });

  it("matches empty query against any text", () => {
    expect(fuzzyMatch("", "anything")).toBe(0);
  });

  it("fails when characters are out of order", () => {
    expect(fuzzyMatch("ba", "abc")).toBeNull();
  });

  it("scores exact matches significantly higher than partial matches", () => {
    const exact = fuzzyMatch("canvas", "canvas");
    const partial = fuzzyMatch("canvas", "canvas editor");
    const subsequence = fuzzyMatch("can", "canvas");
    expect(exact).not.toBeNull();
    expect(partial).not.toBeNull();
    expect(subsequence).not.toBeNull();
    expect(exact).toBeGreaterThan(partial ?? 0);
    expect(exact).toBeGreaterThan(subsequence ?? 0);
  });

  it("exact match returns text.length * EXACT_MATCH_SCORE", () => {
    const text = "canvas";
    expect(fuzzyMatch(text, text)).toBe(text.length * EXACT_MATCH_SCORE);
  });

  it("partial match returns a positive score in [1, text.length * EXACT_MATCH_SCORE)", () => {
    const score = fuzzyMatch("can", "canvas");
    expect(score).not.toBeNull();
    if (score !== null) {
      expect(score).toBeGreaterThanOrEqual(1);
      expect(score).toBeLessThan("canvas".length * EXACT_MATCH_SCORE);
    }
  });

  it("no match returns null", () => {
    expect(fuzzyMatch("xyz", "canvas")).toBeNull();
  });
});

describe("fuzzySearch", () => {
  describe("with string arrays", () => {
    it("filters strings by fuzzy match", () => {
      const result = fuzzySearch(["spaghetti", "pasta", "rice"], "spa");
      expect(result).toEqual(["spaghetti"]);
    });

    it("returns all items when query is empty", () => {
      const items = ["spaghetti", "pasta"];
      expect(fuzzySearch(items, "")).toEqual(items);
    });

    it("returns empty array when nothing matches", () => {
      expect(fuzzySearch(["spaghetti", "pasta"], "xyz")).toEqual([]);
    });

    it("sorts by score (best match first)", () => {
      // "abc" has consecutive matches, "axbxc" has gaps
      const result = fuzzySearch(["axbxc", "abc"], "ab");
      expect(result).toEqual(["abc", "axbxc"]);
    });
  });

  describe("with object arrays", () => {
    const items = [
      { id: "1", name: "spaghetti", category: "pasta" },
      { id: "2", name: "rice", category: "grain" },
      { id: "3", name: "spam", category: "meat" },
    ];

    it("filters objects by the specified key", () => {
      const result = fuzzySearch(items, "name", "spa");
      expect(result).toEqual([
        { id: "1", name: "spaghetti", category: "pasta" },
        { id: "3", name: "spam", category: "meat" },
      ]);
    });

    it("returns all items when query is empty", () => {
      expect(fuzzySearch(items, "name", "")).toEqual(items);
    });

    it("returns empty array when nothing matches", () => {
      expect(fuzzySearch(items, "name", "xyz")).toEqual([]);
    });

    it("works with a different key", () => {
      const result = fuzzySearch(items, "category", "past");
      expect(result).toEqual([
        { id: "1", name: "spaghetti", category: "pasta" },
      ]);
    });
  });

  describe("with caseSensitive option", () => {
    it("matches case-insensitively by default", () => {
      const result = fuzzySearch(["Spaghetti", "rice"], "spa");
      expect(result).toEqual(["Spaghetti"]);
    });

    it("respects case when caseSensitive is true", () => {
      const result = fuzzySearch(["Spaghetti", "spam"], "Spa", {
        caseSensitive: true,
      });
      expect(result).toEqual(["Spaghetti"]);
    });

    it("excludes mismatched case when caseSensitive is true", () => {
      const result = fuzzySearch(["spaghetti"], "Spa", {
        caseSensitive: true,
      });
      expect(result).toEqual([]);
    });
  });
});
