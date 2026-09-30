import { describe, expect, it } from "vitest";

import { renderMarkdownAstToHtml } from "../../src/html.ts";
import { parseMarkdown } from "../../src/parse.ts";
import { mistralSpecAdapter } from "../../src/spec-harness/index.ts";
import type { SpecExample } from "../../src/spec-harness/index.ts";

describe("mistralSpecAdapter", () => {
  it("projects the supported block slice back to HTML", () => {
    const snapshot = parseMarkdown("# Title\n\nHello\n");

    expect(renderMarkdownAstToHtml(snapshot.ast)).toBe(
      "<h1>Title</h1>\n<p>Hello</p>\n",
    );
  });

  it("passes supported CommonMark examples", () => {
    const example: SpecExample = {
      suite: "commonmark",
      number: 1,
      section: "ATX headings",
      startLine: 1,
      endLine: 4,
      markdown: "# Title\n",
      html: "<h1>Title</h1>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("passes HTML block examples once the section is enabled", () => {
    const example: SpecExample = {
      suite: "commonmark",
      number: 149,
      section: "HTML blocks",
      startLine: 1,
      endLine: 10,
      markdown:
        "<table>\n  <tr>\n    <td>\n           hi\n    </td>\n  </tr>\n</table>\n\nokay.\n",
      html: "<table>\n  <tr>\n    <td>\n           hi\n    </td>\n  </tr>\n</table>\n<p>okay.</p>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("skips GFM core-section examples that intentionally conflict with the universal dialect", () => {
    const example: SpecExample = {
      suite: "gfm",
      number: 619,
      section: "Autolinks",
      startLine: 1,
      endLine: 3,
      markdown: "http://example.com\n",
      html: "<p>http://example.com</p>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "skip",
      message:
        "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
    });
  });

  it("skips CommonMark examples that intentionally conflict with the universal dialect", () => {
    const example: SpecExample = {
      suite: "commonmark",
      number: 613,
      section: "Autolinks",
      startLine: 1,
      endLine: 3,
      markdown: "https://example.com\n",
      html: "<p>https://example.com</p>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "skip",
      message:
        "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
    });
  });

  it("uses GFM parsing for extension sections inside the broader GFM spec", () => {
    const example: SpecExample = {
      suite: "gfm",
      number: 628,
      section: "Autolinks (extension)",
      startLine: 1,
      endLine: 3,
      markdown: "http://commonmark.org\n",
      html: '<p><a href="http://commonmark.org">http://commonmark.org</a></p>\n',
      extensions: ["autolink"],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("enables the GFM tag filter for disallowed raw HTML extension cases", () => {
    const example: SpecExample = {
      suite: "gfm",
      number: 652,
      section: "Disallowed Raw HTML (extension)",
      startLine: 1,
      endLine: 3,
      markdown: "This is <xmp> not okay.\n",
      html: "<p>This is &lt;xmp> not okay.</p>\n",
      extensions: ["tagfilter"],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("enables the GFM tag filter for the HTML tag filter extension section", () => {
    const example: SpecExample = {
      suite: "gfm-extensions",
      number: 22,
      section: "HTML tag filter",
      startLine: 1,
      endLine: 3,
      markdown: "This is <xmp> not okay.\n",
      html: "<p>This is &lt;xmp> not okay.</p>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("treats equivalent task-list checkbox HTML as a pass", () => {
    const example: SpecExample = {
      suite: "gfm",
      number: 279,
      section: "Task list items (extension)",
      startLine: 1,
      endLine: 3,
      markdown: "- [x] bar\n",
      html: '<ul>\n<li><input checked="" disabled="" type="checkbox"> bar</li>\n</ul>\n',
      extensions: ["tasklist"],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("accepts the legacy checkbox serialization from the extensions suite", () => {
    const example: SpecExample = {
      suite: "gfm-extensions",
      number: 28,
      section: "Task lists",
      startLine: 1,
      endLine: 3,
      markdown: "- [x] bar\n",
      html: '<ul>\n<li><input type="checkbox" checked="" disabled="" /> bar</li>\n</ul>\n',
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("matches the broader GFM nested-strong rendering expectation", () => {
    const example: SpecExample = {
      suite: "gfm",
      number: 398,
      section: "Emphasis and strong emphasis",
      startLine: 1,
      endLine: 3,
      markdown: "__foo, __bar__, baz__\n",
      html: "<p><strong>foo, bar, baz</strong></p>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toEqual({
      status: "pass",
    });
  });

  it("still marks unknown sections as not implemented", () => {
    const example: SpecExample = {
      suite: "commonmark",
      number: 999,
      section: "Unsupported custom section",
      startLine: 1,
      endLine: 3,
      markdown: "text\n",
      html: "<p>text</p>\n",
      extensions: [],
    };

    expect(mistralSpecAdapter.evaluate(example)).toMatchObject({
      status: "not_implemented",
    });
  });
});
