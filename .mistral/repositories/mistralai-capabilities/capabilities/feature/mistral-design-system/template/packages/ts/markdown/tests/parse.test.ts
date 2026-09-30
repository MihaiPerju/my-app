import { describe, expect, it } from "vitest";

import { parseMarkdown } from "../src/index.ts";

describe("parseMarkdown", () => {
  it("parses the initial block slice into mdast-compatible nodes", () => {
    const snapshot = parseMarkdown(
      "# Title\n\nAlpha\nBeta\n\n---\n\n```ts\nconst answer = 42;\n```\n",
    );

    expect(snapshot).toMatchObject({
      finalized: true,
      diagnostics: [],
      ast: {
        type: "root",
        children: [
          {
            type: "heading",
            depth: 1,
            children: [
              {
                type: "text",
                value: "Title",
              },
            ],
          },
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Alpha\nBeta",
              },
            ],
          },
          {
            type: "thematicBreak",
          },
          {
            type: "code",
            lang: "ts",
            value: "const answer = 42;",
          },
        ],
      },
    });
    expect(snapshot).not.toHaveProperty("state");
  });

  it("finalizes an unfinished fenced block in one-shot mode", () => {
    const snapshot = parseMarkdown("```ts\nconst answer = 42;");

    expect(snapshot).toMatchObject({
      finalized: true,
      diagnostics: [],
      ast: {
        type: "root",
        children: [
          {
            type: "code",
            lang: "ts",
            value: "const answer = 42;",
          },
        ],
      },
    });
  });

  it("treats standalone HTML tags as flow blocks and decodes fence info escapes", () => {
    const snapshot = parseMarkdown(
      '<a href="/bar\\/)">\n\n``` foo\\+bar\nfoo\n```\n',
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "html",
          value: '<a href="/bar\\/)">\n',
        },
        {
          type: "code",
          lang: "foo+bar",
          value: "foo",
        },
      ],
    });
  });

  it("applies CommonMark HTML block interruption rules", () => {
    const snapshot = parseMarkdown(
      'Foo\n<a href="bar">\nbaz\n\n<div>\nbar\n</div>\n',
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Foo\n",
            },
            {
              type: "html",
              value: '<a href="bar">',
            },
            {
              type: "text",
              value: "\nbaz",
            },
          ],
        },
        {
          type: "html",
          value: "<div>\nbar\n</div>\n",
        },
      ],
    });
  });

  it("parses nested container and inline constructs in the current expanded slice", () => {
    const snapshot = parseMarkdown(
      "> ```\n> aaa\n\n- * * *\n\nFoo\n---\n\n`bar`\n",
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "blockquote",
          children: [
            {
              type: "code",
              value: "aaa",
            },
          ],
        },
        {
          type: "list",
          children: [
            {
              type: "listItem",
              children: [
                {
                  type: "thematicBreak",
                },
              ],
            },
          ],
        },
        {
          type: "heading",
          depth: 2,
          children: [
            {
              type: "text",
              value: "Foo",
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "inlineCode",
              value: "bar",
            },
          ],
        },
      ],
    });
  });

  it("marks a list spread when fenced-code items are separated by a blank line", () => {
    const snapshot = parseMarkdown(
      "- first:\n  ```ts\n  const a = 1;\n\n  const b = 2;\n  ```\n\n- second:\n  ```ts\n  const c = 3;\n  ```\n",
    );

    expect(snapshot.ast.children[0]).toMatchObject({
      type: "list",
      spread: true,
      children: [
        {
          type: "listItem",
          spread: false,
        },
        {
          type: "listItem",
          spread: false,
        },
      ],
    });
  });

  it("parses links, autolinks, raw HTML, and emphasis around inline nodes", () => {
    const snapshot = parseMarkdown(
      '*foo [bar](/uri "title")* <https://foo.bar.baz> <responsive-image src="foo.jpg" /> `baz`\n',
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [
                {
                  type: "text",
                  value: "foo ",
                },
                {
                  type: "link",
                  url: "/uri",
                  title: "title",
                  children: [
                    {
                      type: "text",
                      value: "bar",
                    },
                  ],
                },
              ],
            },
            {
              type: "text",
              value: " ",
            },
            {
              type: "link",
              url: "https://foo.bar.baz",
              children: [
                {
                  type: "text",
                  value: "https://foo.bar.baz",
                },
              ],
            },
            {
              type: "text",
              value: " ",
            },
            {
              type: "html",
              value: '<responsive-image src="foo.jpg" />',
            },
            {
              type: "text",
              value: " ",
            },
            {
              type: "inlineCode",
              value: "baz",
            },
          ],
        },
      ],
    });
  });

  it("consumes a trailing reference definition without emitting a paragraph", () => {
    const snapshot = parseMarkdown("[foo]: /bar");

    expect(snapshot).toMatchObject({
      finalized: true,
      diagnostics: [],
      ast: {
        type: "root",
        children: [],
      },
    });
  });

  it("resolves nested emphasis and strong delimiter runs", () => {
    const snapshot = parseMarkdown("*foo**bar**baz*\n**foo*bar*baz**\n");

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [
                {
                  type: "text",
                  value: "foo",
                },
                {
                  type: "strong",
                  children: [
                    {
                      type: "text",
                      value: "bar",
                    },
                  ],
                },
                {
                  type: "text",
                  value: "baz",
                },
              ],
            },
            {
              type: "text",
              value: "\n",
            },
            {
              type: "strong",
              children: [
                {
                  type: "text",
                  value: "foo",
                },
                {
                  type: "emphasis",
                  children: [
                    {
                      type: "text",
                      value: "bar",
                    },
                  ],
                },
                {
                  type: "text",
                  value: "baz",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("does not interrupt a paragraph with an empty list marker line", () => {
    const snapshot = parseMarkdown("*foo bar\n*\n");

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "*foo bar\n*",
            },
          ],
        },
      ],
    });
  });

  it("resolves reference links and strips link definitions from the AST", () => {
    const snapshot = parseMarkdown(
      '[foo][bar]\n\n[bar]: /url "title"\n\n![[[foo](uri1)](uri2)](uri3)\n',
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "/url",
              title: "title",
              children: [
                {
                  type: "text",
                  value: "foo",
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "image",
              url: "uri3",
              alt: "[foo](uri2)",
            },
          ],
        },
      ],
    });
  });

  it("resolves multiline reference definitions and strips them from the AST", () => {
    const snapshot = parseMarkdown("[Foo\n  bar]: /url\n\n[Baz][Foo bar]\n");

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "/url",
              children: [
                {
                  type: "text",
                  value: "Baz",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("normalizes soft breaks, nested image labels, and invalid reference titles", () => {
    const snapshot = parseMarkdown(
      "foo \n baz\n\n![foo ![bar](/url)](/url2)\n\n[foo]: /url 'title\n\nwith blank line'\n\n[foo]\n",
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "foo\nbaz",
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "image",
              url: "/url2",
              alt: "foo bar",
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "[foo]: /url 'title",
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "with blank line'",
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "[foo]",
            },
          ],
        },
      ],
    });
  });

  it("decodes character references in text, links, and fence info", () => {
    const snapshot = parseMarkdown(
      '&nbsp; &#35; &#0;\n\n[foo](/f&ouml;&ouml; "f&ouml;&ouml;")\n\n``` f&ouml;&ouml;\nfoo\n```\n',
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "\u00A0 # \uFFFD",
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "/f%C3%B6%C3%B6",
              title: "föö",
              children: [
                {
                  type: "text",
                  value: "foo",
                },
              ],
            },
          ],
        },
        {
          type: "code",
          lang: "föö",
          value: "foo",
        },
      ],
    });
  });

  it("recognizes literal autolinks in the universal dialect", () => {
    const snapshot = parseMarkdown("https://example.com foo@bar.example.com\n");

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com",
              children: [
                {
                  type: "text",
                  value: "https://example.com",
                },
              ],
            },
            {
              type: "text",
              value: " ",
            },
            {
              type: "link",
              url: "mailto:foo@bar.example.com",
              children: [
                {
                  type: "text",
                  value: "foo@bar.example.com",
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it("treats footnote syntax as footnotes in the universal dialect", () => {
    const source = "[^note]: /url\n\n[^note]\n";
    const snapshot = parseMarkdown(source);

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "footnoteDefinition",
          identifier: "note",
          label: "note",
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: "text",
                  value: "/url",
                },
              ],
            },
          ],
        },
        {
          type: "paragraph",
          children: [
            {
              type: "footnoteReference",
              identifier: "note",
              label: "note",
            },
          ],
        },
      ],
    });
  });

  it("parses inline math and block math in the default Mistral dialect", () => {
    const snapshot = parseMarkdown(
      "Energy is $mc^2$.\n\n$$ tex\nx + y\n$$\n\n$$a+b$$\n",
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Energy is ",
            },
            {
              type: "inlineMath",
              value: "mc^2",
            },
            {
              type: "text",
              value: ".",
            },
          ],
        },
        {
          type: "math",
          meta: "tex",
          value: "x + y\n",
        },
        {
          type: "math",
          meta: null,
          value: "a+b",
        },
      ],
    });
  });

  it("supports parenthesized and bracketed LaTeX delimiters in the default Mistral dialect", () => {
    const snapshot = parseMarkdown(
      "The formula \\(x^2 + y^2\\) is famous.\n\n\\[\nx^2 + y^2 = z^2\n\\]\n",
    );

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "The formula ",
            },
            {
              type: "inlineMath",
              value: "x^2 + y^2",
            },
            {
              type: "text",
              value: " is famous.",
            },
          ],
        },
        {
          type: "math",
          value: "x^2 + y^2 = z^2\n",
        },
      ],
    });
  });
});
