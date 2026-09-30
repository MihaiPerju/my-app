import { describe, expect, it } from "vitest";

import { sanitizeMarkdownUrl } from "../src/url.ts";

describe("sanitizeMarkdownUrl", () => {
  it.each([
    "https://example.com",
    "http://example.com",
    "mailto:test@example.com",
    "irc://example.com/channel",
    "ircs://example.com/channel",
    "xmpp:user@example.com",
    "/docs",
    "./docs",
    "../docs",
    "?q=docs",
    "#docs",
    "/docs:part",
  ])("preserves safe markdown URL %s", (url) => {
    expect(sanitizeMarkdownUrl(url)).toBe(url);
  });

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "vbscript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "component://missing",
    "docs:part",
  ])("drops unsafe or unknown URL %s", (url) => {
    expect(sanitizeMarkdownUrl(url)).toBeUndefined();
  });

  it("preserves URLs allowed by the caller", () => {
    expect(
      sanitizeMarkdownUrl(
        "component://abc123",
        (url) => url === "component://abc123",
      ),
    ).toBe("component://abc123");
  });

  it("trims before checking caller-allowed URLs but returns the original URL", () => {
    expect(
      sanitizeMarkdownUrl(
        " component://abc123 ",
        (url) => url === "component://abc123",
      ),
    ).toBe(" component://abc123 ");
  });
});
