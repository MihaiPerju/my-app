import { describe, expect, it } from "vitest";

import { renderMarkdownAstToHtml } from "../src/html.ts";
import { parseMarkdown } from "../src/parse.ts";

describe("GFM regressions", () => {
  it("keeps paragraph-like continuation rows inside tables", () => {
    const snapshot = parseMarkdown(
      "| abc | def |\n| --- | --- |\n| bar | baz |\nbar\n\nbar\n",
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "table",
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "abc" }],
                },
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "def" }],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "bar" }],
                },
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "baz" }],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [{ type: "text", value: "bar" }],
                },
                {
                  type: "tableCell",
                  children: [],
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [{ type: "text", value: "bar" }],
        },
      ],
    });
  });

  it("stops literal autolinks before entity-like tails", () => {
    const snapshot = parseMarkdown("www.google.com/search?q=commonmark&hl;\n");

    expect(renderMarkdownAstToHtml(snapshot.ast)).toBe(
      '<p><a href="http://www.google.com/search?q=commonmark">www.google.com/search?q=commonmark</a>&amp;hl;</p>\n',
    );
  });

  it("supports ftp literal autolinks", () => {
    const snapshot = parseMarkdown(
      "Anonymous FTP is available at ftp://foo.bar.baz.\n",
    );

    expect(renderMarkdownAstToHtml(snapshot.ast)).toBe(
      '<p>Anonymous FTP is available at <a href="ftp://foo.bar.baz">ftp://foo.bar.baz</a>.</p>\n',
    );
  });

  it("detects email literal autolinks after a protocol-like prefix miss", () => {
    const snapshot = parseMarkdown(
      "hello@mail+xyz.example isn't valid, but hello+xyz@mail.example is.\n",
    );

    expect(renderMarkdownAstToHtml(snapshot.ast)).toBe(
      `<p>hello@mail+xyz.example isn't valid, but <a href="mailto:hello+xyz@mail.example">hello+xyz@mail.example</a> is.</p>\n`,
    );
  });

  it("rejects email literal autolinks followed by dashes or underscores", () => {
    const snapshot = parseMarkdown("a.b-c_d@a.b-\n\na.b-c_d@a.b_\n");

    expect(renderMarkdownAstToHtml(snapshot.ast)).toBe(
      "<p>a.b-c_d@a.b-</p>\n<p>a.b-c_d@a.b_</p>\n",
    );
  });

  it("preserves nested strong runs in the universal dialect", () => {
    const simple = parseMarkdown("____foo____\n");
    const nested = parseMarkdown("__foo, __bar__, baz__\n");

    expect(renderMarkdownAstToHtml(simple.ast)).toBe(
      "<p><strong><strong>foo</strong></strong></p>\n",
    );
    expect(renderMarkdownAstToHtml(nested.ast)).toBe(
      "<p><strong>foo, <strong>bar</strong>, baz</strong></p>\n",
    );
  });
});
