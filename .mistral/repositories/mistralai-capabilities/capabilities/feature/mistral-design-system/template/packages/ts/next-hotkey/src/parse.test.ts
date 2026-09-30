import { describe, expect, it } from "vitest";

import { MAPPED_KEYS } from "./constants";
import { normalizeKey, parseHotkey } from "./parse";

describe("normalizeKey", () => {
  it("transforms to lower case", () => {
    expect(normalizeKey("Escape")).toBe("escape");
    expect(normalizeKey("Enter")).toBe("enter");
    expect(normalizeKey("Shift")).toBe("shift");
    expect(normalizeKey("Control")).toBe("ctrl");
    expect(normalizeKey("Meta")).toBe("meta");
  });

  it.each(Object.entries(MAPPED_KEYS))(
    'maps alias "%s" to "%s"',
    (alias, expected) => {
      expect(normalizeKey(alias)).toBe(expected);
    },
  );
});

describe("parseHotkey", () => {
  it("parses basic modifier hotkeys", () => {
    const result = parseHotkey("ctrl+alt+shift+k");
    expect(result.ctrl).toBe(true);
    expect(result.alt).toBe(true);
    expect(result.shift).toBe(true);
    expect(result.meta).toBe(false);
    expect(result.keys).toContain("k");
  });

  it("handles different casing and aliases", () => {
    const result = parseHotkey("Control+ENTER+K");
    expect(result.ctrl).toBe(true);
    expect(result.keys).toContain("enter");
    expect(result.keys).toContain("k");
  });

  it("handles custom separators", () => {
    const result = parseHotkey("ctrl|shift|x", "|");
    expect(result.ctrl).toBe(true);
    expect(result.shift).toBe(true);
    expect(result.keys).toContain("x");
  });

  it("handles mod key", () => {
    const result = parseHotkey("mod+k");
    expect(result.mod).toBe(true);
    expect(result.keys).toContain("k");
  });

  it("excludes modifier keywords from keys array", () => {
    const result = parseHotkey("shift+ctrl+enter");
    expect(result.keys).toContain("enter");
    expect(result.keys).not.toContain("ctrl");
    expect(result.keys).not.toContain("shift");
  });
});
