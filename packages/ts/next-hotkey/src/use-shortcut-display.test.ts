import { afterEach, describe, expect, it, vi } from "vitest";

import { getIsMacPlatform } from "./use-shortcut-display";

describe("getIsMacPlatform", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe("userAgentData fast path (Chromium browsers)", () => {
    it("returns true when userAgentData.platform contains 'macOS'", () => {
      vi.stubGlobal("navigator", {
        userAgentData: { platform: "macOS" },
      });

      expect(getIsMacPlatform()).toBe(true);
    });

    it("returns true when userAgentData.platform contains 'Mac' (case-insensitive)", () => {
      vi.stubGlobal("navigator", {
        userAgentData: { platform: "mac" },
      });

      expect(getIsMacPlatform()).toBe(true);
    });

    it("returns false when userAgentData.platform is 'Windows'", () => {
      vi.stubGlobal("navigator", {
        userAgentData: { platform: "Windows" },
      });

      expect(getIsMacPlatform()).toBe(false);
    });
  });

  describe("userAgent fallback (non-Chromium browsers)", () => {
    it.each([
      ["Mac", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"],
      ["iPhone", "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)"],
      ["iPad", "Mozilla/5.0 (iPad; CPU OS 17_0)"],
      ["iPod", "Mozilla/5.0 (iPod touch; CPU iPhone OS 17_0)"],
    ])("returns true for %s user agent", (_label, userAgent) => {
      vi.stubGlobal("navigator", { userAgent });

      expect(getIsMacPlatform()).toBe(true);
    });

    it("returns false for a Windows user agent", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
      });

      expect(getIsMacPlatform()).toBe(false);
    });

    it("returns false for a Linux user agent", () => {
      vi.stubGlobal("navigator", {
        userAgent: "Mozilla/5.0 (X11; Linux x86_64)",
      });

      expect(getIsMacPlatform()).toBe(false);
    });
  });
});
