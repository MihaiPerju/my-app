import { describe, expect, it } from "vitest";

import {
  createMarkdownSession,
  parseMarkdown,
  type MarkdownSnapshot,
} from "../src/index.ts";

type LegacyMarkdownSession = {
  getSnapshot(): MarkdownSnapshot;
  append(chunk: string): MarkdownSnapshot;
  finalize(): MarkdownSnapshot;
};

function createLegacySession(): LegacyMarkdownSession {
  const session = createMarkdownSession();
  let source = "";
  let finalized = false;
  let snapshot = session.parse(source, finalized);

  return {
    getSnapshot(): MarkdownSnapshot {
      return snapshot;
    },
    append(chunk: string): MarkdownSnapshot {
      if (chunk.length === 0) {
        return snapshot;
      }
      if (finalized) {
        throw new Error("Cannot append source after finalization.");
      }

      source += chunk;
      snapshot = session.parse(source, false);

      return snapshot;
    },
    finalize(): MarkdownSnapshot {
      finalized = true;
      snapshot = session.parse(source, true);

      return snapshot;
    },
  };
}

function expectFinalIncrementalParity(
  source: string,
  splitIndex: number,
): void {
  const session = createLegacySession();

  session.append(source.slice(0, splitIndex));
  session.append(source.slice(splitIndex));

  expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
}

function appendCharByChar(source: string): MarkdownSnapshot {
  const session = createLegacySession();
  let snapshot = session.getSnapshot();

  for (const character of source) {
    snapshot = session.append(character);
  }

  return snapshot;
}

function expectSnapshotParity(
  actual: MarkdownSnapshot,
  expected: MarkdownSnapshot,
  context: string,
): void {
  try {
    expect(actual.finalized).toBe(expected.finalized);
    expect(actual.sourceLength).toBe(expected.sourceLength);
    expect(actual.diagnostics).toEqual(expected.diagnostics);
    expect(actual.ast).toEqual(expected.ast);
  } catch (error) {
    if (error instanceof Error) {
      error.message = `${context}\n${error.message}`;
    }

    throw error;
  }
}

function expectStreamingProjectionParityAcrossCuts(source: string): void {
  for (let prefixLength = 1; prefixLength <= source.length; prefixLength += 1) {
    const prefix = source.slice(0, prefixLength);
    const expected = createLegacySession().append(prefix);

    expectSnapshotParity(
      appendCharByChar(prefix),
      expected,
      `char-by-char prefix length ${prefixLength}`,
    );

    for (let cut = 1; cut < prefix.length; cut += 1) {
      const session = createLegacySession();

      session.append(prefix.slice(0, cut));
      const actual = session.append(prefix.slice(cut));

      expectSnapshotParity(
        actual,
        expected,
        `prefix length ${prefixLength}, cut ${cut}`,
      );
    }
  }
}

describe("createMarkdownSession", () => {
  it("exposes stable snapshots for repeated identical parse inputs", () => {
    const session = createMarkdownSession();
    const snapshot = session.parse("");

    expect(snapshot).toMatchObject({
      ast: {
        type: "root",
        children: [],
      },
      diagnostics: [],
      finalized: false,
      sourceLength: 0,
    });
    expect(snapshot).not.toHaveProperty("state");

    expect(session.parse("")).toBe(snapshot);
  });

  it("reuses unchanged block nodes across appends", () => {
    const session = createLegacySession();
    const first = session.append("# Title\n\n");
    const second = session.append("Hello");

    expect(first.sourceLength).toBe(9);
    expect(second.sourceLength).toBe(14);
    expect(first.ast.children[0]).toBe(second.ast.children[0]);
    expect(second).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 9,
        },
      ],
      ast: {
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
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "text",
                value: "Hello",
              },
            ],
          },
        ],
      },
    });

    const finalized = session.finalize();

    expect(finalized.diagnostics).toEqual([]);
    expect(finalized.ast).toEqual(parseMarkdown("# Title\n\nHello").ast);
  });

  it("falls back to reparsing when append-only input continues the same line", () => {
    const session = createLegacySession();

    session.append("<script></script>");
    const appended = session.append("tail\n");

    expect(appended.ast).toEqual(parseMarkdown("<script></script>tail\n").ast);
  });

  it("continues the trailing paragraph across a later line append", () => {
    const session = createLegacySession();

    session.append("Alpha paragraph line.\n");
    session.append("Beta paragraph line.\n");

    expect(session.finalize().ast).toEqual(
      parseMarkdown("Alpha paragraph line.\nBeta paragraph line.\n").ast,
    );
  });

  it("keeps indented paragraph continuations inside the paragraph", () => {
    const session = createLegacySession();

    session.append("alpha\n");
    session.append("    beta");
    session.append("\n    gamma");

    expect(session.finalize().ast).toEqual(
      parseMarkdown("alpha\n    beta\n    gamma").ast,
    );
  });

  it("keeps closed bracketed paragraphs stable while unrelated tail text streams", () => {
    const session = createLegacySession();
    const first = session.append("const [value] = useState(0);\n\n");
    const second = session.append("Next paragraph");

    expect(second.ast.children[0]).toBe(first.ast.children[0]);
    expect(session.finalize().ast).toEqual(
      parseMarkdown("const [value] = useState(0);\n\nNext paragraph").ast,
    );
  });

  it("continues a trailing block quote across a later line append", () => {
    const session = createLegacySession();

    session.append("> quoted line\n");
    session.append("> continued line\n");

    expect(session.finalize().ast).toEqual(
      parseMarkdown("> quoted line\n> continued line\n").ast,
    );
  });

  it("continues a trailing list across a later line append", () => {
    const session = createLegacySession();

    session.append("- first item\n");
    session.append("- second item\n");

    expect(session.finalize().ast).toEqual(
      parseMarkdown("- first item\n- second item\n").ast,
    );
  });

  it("reuses previous list items when appending text inside the final nested item", () => {
    const session = createLegacySession();
    const initialSource = [
      "- Step 1",
      "  - Inspect the trace",
      "- Step 2",
      "  - Update the benchmark",
    ].join("\n");
    const initial = session.append(initialSource);
    const appended = session.append(" and parser fast path");
    const initialList = initial.ast.children[0];
    const appendedList = appended.ast.children[0];

    expect(initialList?.type).toBe("list");
    expect(appendedList?.type).toBe("list");

    if (initialList?.type !== "list" || appendedList?.type !== "list") {
      throw new Error("Expected list nodes.");
    }

    expect(appendedList.children[0]).toBe(initialList.children[0]);
    expect(session.finalize().ast).toEqual(
      parseMarkdown(`${initialSource} and parser fast path`).ast,
    );
    expectStreamingProjectionParityAcrossCuts("- Step\n  - Update benchmark");
  });

  it("tracks unfinished fenced code until finalization", () => {
    const session = createLegacySession();
    const streaming = session.append("```ts\nconst answer = 42;");

    expect(streaming).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "code",
            lang: "ts",
            value: "const answer = 42;",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });

    expect(session.finalize()).toMatchObject({
      finalized: true,
      diagnostics: [],
      ast: {
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

  it("drops optimistic table cell inline projections when finalizing", () => {
    const source = "| Latency |\n| - |\n| ~50ms |";
    const session = createLegacySession();

    for (const character of source) {
      session.append(character);
    }

    expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
  });

  it("keeps streamed indentation before html-looking indented code", () => {
    const source = "    <script>\n    const answer = 42;\n    </script>";
    const session = createLegacySession();

    for (const character of source) {
      session.append(character);
    }

    expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
  });

  it("tracks unfinished math blocks across appends", () => {
    const session = createLegacySession();
    const streaming = session.append("\\[\nx^2 + y^2");

    expect(streaming).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "math",
            value: "x^2 + y^2",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });

    expect(session.append("\n\\]\n")).toMatchObject({
      finalized: false,
      diagnostics: [],
      ast: {
        children: [
          {
            type: "math",
            value: "x^2 + y^2\n",
          },
        ],
      },
    });
  });

  it("tracks unfinished HTML blocks across appends", () => {
    const session = createLegacySession();
    const streaming = session.append("<script>\nconst answer = 42;");

    expect(streaming).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "html",
            value: "<script>\nconst answer = 42;",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });

    expect(session.append("\n</script>\n\nDone.\n")).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 39,
        },
      ],
      ast: {
        children: [
          {
            type: "html",
            value: "<script>\nconst answer = 42;\n</script>\n",
          },
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Done.",
              },
            ],
          },
        ],
      },
    });
  });

  it("marks an unterminated setext heading as unfinished until finalization", () => {
    const session = createLegacySession();
    const streaming = session.append("Title\n---");

    expect(streaming).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "heading",
            depth: 2,
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "text",
                value: "Title",
              },
            ],
          },
        ],
      },
    });

    expect(session.finalize()).toMatchObject({
      finalized: true,
      diagnostics: [],
      ast: {
        children: [
          {
            type: "heading",
            depth: 2,
            children: [
              {
                type: "text",
                value: "Title",
              },
            ],
          },
        ],
      },
    });
  });

  it("suppresses a streamed list marker until it has enough signal", () => {
    const session = createLegacySession();
    const streaming = session.append("here is a list\n-");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "text",
                value: "here is a list",
              },
            ],
          },
        ],
      },
    });
    expect(session.append(" item").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "here is a list",
            },
          ],
        },
        {
          type: "list",
          children: [
            {
              type: "listItem",
            },
          ],
        },
      ],
    });
  });

  it.each([
    "3",
    "3.",
    "3. ",
    "3. *",
    "3. **",
    "4",
    "4.",
    "4. ",
    "4. *",
    "4. **",
  ])("suppresses ambiguous streamed ordered list marker: %s", (marker) => {
    const session = createLegacySession();

    expect(session.append(`Before\n\n${marker}`).ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
      ],
    });
  });

  it("reveals streamed ordered list markers when item content arrives", () => {
    const session = createLegacySession();

    session.append("Before\n\n3");
    session.append(". ");

    expect(session.append("Keep references").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
        {
          type: "list",
          ordered: true,
          start: 3,
          children: [
            {
              type: "listItem",
              children: [
                {
                  type: "paragraph",
                  children: [
                    {
                      type: "text",
                      value: "Keep references",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each([
    "3",
    "3.",
    "3. ",
    "3. *",
    "3. **",
    "4",
    "4.",
    "4. ",
    "4. *",
    "4. **",
  ])(
    "suppresses ambiguous trailing markers appended to an existing ordered list: %s",
    (marker) => {
      const session = createLegacySession();

      expect(
        session.append(`1. Keep references\n2. Compare\n${marker}`).ast,
      ).toMatchObject({
        children: [
          {
            type: "list",
            ordered: true,
            start: 1,
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      {
                        type: "text",
                        value: "Keep references",
                      },
                    ],
                  },
                ],
              },
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      {
                        type: "text",
                        value: "Compare",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      });
    },
  );

  it("suppresses ambiguous setext underlines during streaming and restores them on finalize", () => {
    const session = createLegacySession();
    const streaming = session.append("Title\n=");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "text",
                value: "Title",
              },
            ],
          },
        ],
      },
    });

    expect(session.append("=").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Title",
            },
          ],
        },
      ],
    });

    expect(session.append("=").ast).toMatchObject({
      children: [
        {
          type: "heading",
          depth: 1,
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
          children: [
            {
              type: "text",
              value: "Title",
            },
          ],
        },
      ],
    });

    expect(session.finalize().ast).toEqual(parseMarkdown("Title\n===").ast);
  });

  it("suppresses ambiguous thematic break starters until the marker run is complete", () => {
    const session = createLegacySession();
    const first = session.append("Before\n\n-");

    expect(first).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Before",
              },
            ],
          },
        ],
      },
    });

    const second = session.append("-");

    expect(second.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
      ],
    });

    const third = session.append("-");

    expect(third.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
        {
          type: "thematicBreak",
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
        },
      ],
    });

    expect(session.finalize().ast).toEqual(parseMarkdown("Before\n\n---").ast);
  });

  it("reuses the AST root when finalization does not change the tree", () => {
    const session = createLegacySession();
    const streaming = session.append("# Title\n");
    const finalized = session.finalize();

    expect(streaming.diagnostics).toEqual([]);
    expect(finalized.ast).toBe(streaming.ast);
  });

  it("reuses inline children when finalization only closes the parent block", () => {
    const session = createLegacySession();
    const streaming = session.append("*Hello*");
    const finalized = session.finalize();

    const streamingParagraph = streaming.ast.children[0];
    const finalizedParagraph = finalized.ast.children[0];

    expect(streamingParagraph).toMatchObject({
      type: "paragraph",
      data: {
        mistralMarkdown: {
          unfinished: true,
          optimistic: true,
        },
      },
    });
    expect(finalizedParagraph).toMatchObject({
      type: "paragraph",
    });
    expect(finalizedParagraph).not.toBe(streamingParagraph);
    expect(finalizedParagraph?.type).toBe("paragraph");
    expect(streamingParagraph?.type).toBe("paragraph");

    if (
      finalizedParagraph?.type === "paragraph" &&
      streamingParagraph?.type === "paragraph"
    ) {
      expect(finalizedParagraph.children).toBe(streamingParagraph.children);
      expect(finalizedParagraph.children[0]).toBe(
        streamingParagraph.children[0],
      );
    }
  });

  it("returns stable references for repeated identical inputs", () => {
    const session = createMarkdownSession();

    const initial = session.parse("");
    expect(session.parse("")).toBe(initial);

    const streaming = session.parse("# Title\n");
    expect(session.parse("# Title\n")).toBe(streaming);

    const finalized = session.parse("# Title\n", true);
    expect(session.parse("# Title\n", true)).toBe(finalized);
  });

  it("reparses from scratch when the new source is not an append of the previous source", () => {
    const session = createMarkdownSession();

    session.parse("Hello world", false);
    const reparsed = session.parse("Hello", false);

    expect(reparsed).toEqual(createMarkdownSession().parse("Hello", false));
  });

  it("reparses from scratch when a longer new source is not prefixed by the previous source", () => {
    const session = createMarkdownSession();

    session.parse("Hello", false);
    const reparsed = session.parse("Well, Hello", false);

    expect(reparsed).toEqual(
      createMarkdownSession().parse("Well, Hello", false),
    );
  });

  it("starts a new unfinished lifecycle when done flips from true to false", () => {
    const session = createMarkdownSession();

    const finalized = session.parse("**Bold", true);
    const streaming = session.parse("**Bold", false);

    expect(finalized.finalized).toBe(true);
    expect(streaming.finalized).toBe(false);
    expect(streaming.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
        },
      ],
    });
  });

  it("upgrades earlier footnote references when a definition arrives later", () => {
    const session = createLegacySession();
    const beforeDefinition = session.append("See [^note]\n\n");
    const afterDefinition = session.append("[^note]: later\n");

    expect(beforeDefinition.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "See [^note]",
            },
          ],
        },
      ],
    });
    expect(afterDefinition.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "See ",
            },
            {
              type: "footnoteReference",
              identifier: "note",
              label: "note",
            },
          ],
        },
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
                  value: "later",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(afterDefinition.ast.children[0]).not.toBe(
      beforeDefinition.ast.children[0],
    );
  });

  it("upgrades earlier link references when a definition arrives later", () => {
    const session = createLegacySession();
    const beforeDefinition = session.append("See [ref]\n\n");
    const afterDefinition = session.append("[ref]: /url\n");

    expect(beforeDefinition.diagnostics).toEqual([]);
    expect(beforeDefinition.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "See [ref]",
            },
          ],
        },
      ],
    });
    expect(afterDefinition.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "See ",
            },
            {
              type: "link",
              url: "/url",
              children: [
                {
                  type: "text",
                  value: "ref",
                },
              ],
            },
          ],
        },
      ],
    });
    expect(afterDefinition.diagnostics).toEqual([]);
    expect(afterDefinition.ast.children[0]).not.toBe(
      beforeDefinition.ast.children[0],
    );
  });

  it("reparses a trailing reference definition split mid-destination", () => {
    const session = createLegacySession();
    const source = "[Foo\n  bar]: /url\n\n[Baz][Foo bar]\n";
    const beforeDefinition = session.append("[Foo\n  bar]: /u");
    const afterDefinition = session.append("rl\n\n[Baz][Foo bar]\n");
    const finalized = session.finalize();

    expect(beforeDefinition.diagnostics).toEqual([]);
    expect(beforeDefinition.ast).toMatchObject({
      children: [],
    });
    expect(afterDefinition.diagnostics).toEqual([
      {
        code: "unfinished-input",
        message: "Input is still unfinished around the trailing paragraph.",
        offset: 19,
      },
    ]);
    expect(afterDefinition.ast).toMatchObject({
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
    expect(finalized.diagnostics).toEqual([]);
    expect(finalized.ast).toEqual(parseMarkdown(source).ast);
  });

  it("reparses a multiline label definition split mid-destination", () => {
    const session = createLegacySession();
    const source = "[\nfoo\n]: /url\nbar";
    const beforeDefinition = session.append("[\nfoo\n]: /u");
    const afterDefinition = session.append("rl\nbar");
    const finalized = session.finalize();

    expect(beforeDefinition.diagnostics).toEqual([]);
    expect(beforeDefinition.ast).toMatchObject({
      children: [],
    });
    expect(afterDefinition.diagnostics).toEqual([
      {
        code: "unfinished-input",
        message: "Input is still unfinished around the trailing paragraph.",
        offset: 14,
      },
    ]);
    expect(afterDefinition.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "bar",
            },
          ],
        },
      ],
    });
    expect(finalized.diagnostics).toEqual([]);
    expect(finalized.ast).toEqual(parseMarkdown(source).ast);
  });

  it("upgrades earlier heading link references when a definition arrives later", () => {
    const session = createLegacySession();
    const source = "# [foo][bar]\n\n[bar]: /url\n";
    const beforeDefinition = session.append("# [foo][bar]\n\n");
    const afterDefinition = session.append("[bar]: /url\n");

    expect(beforeDefinition.diagnostics).toEqual([]);
    expect(beforeDefinition.ast).toMatchObject({
      children: [
        {
          type: "heading",
          depth: 1,
          children: [
            {
              type: "text",
              value: "[foo][bar]",
            },
          ],
        },
      ],
    });
    expect(afterDefinition.diagnostics).toEqual([]);
    expect(afterDefinition.ast).toEqual(parseMarkdown(source).ast);
  });

  it("upgrades earlier table link references when a definition arrives later", () => {
    const session = createLegacySession();
    const source = "| ref |\n| --- |\n| [foo][bar] |\n\n[bar]: /url\n";
    const beforeDefinition = session.append(
      "| ref |\n| --- |\n| [foo][bar] |\n\n",
    );
    const afterDefinition = session.append("[bar]: /url\n");

    expect(beforeDefinition.diagnostics).toEqual([]);
    expect(beforeDefinition.ast).toMatchObject({
      children: [
        {
          type: "table",
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "ref",
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "[foo][bar]",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(afterDefinition.diagnostics).toEqual([]);
    expect(afterDefinition.ast).toEqual(parseMarkdown(source).ast);
  });

  it("matches one-shot parsing when a CRLF line break is split across appends", () => {
    const session = createLegacySession();

    expect(session.append("alpha\r").ast).toMatchObject(
      parseMarkdown("alpha\r").ast,
    );
    expect(session.append("\nbeta").ast).toMatchObject(
      parseMarkdown("alpha\r\nbeta").ast,
    );
    expect(session.finalize().ast).toEqual(parseMarkdown("alpha\r\nbeta").ast);
  });

  it("suppresses unfinished inline dollar math until the closer arrives", () => {
    const session = createLegacySession();
    const beforeCloser = session.append("Value $x");
    const afterCloser = session.append("$");

    expect(beforeCloser).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Value ",
              },
            ],
          },
        ],
      },
    });
    expect(afterCloser).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Value ",
              },
              {
                type: "inlineMath",
                value: "x",
              },
            ],
          },
        ],
      },
    });
    expect(session.finalize().ast).toEqual(parseMarkdown("Value $x$").ast);
  });

  it("optimistically closes parenthesized inline math before the closer arrives", () => {
    const session = createLegacySession();
    const streaming = session.append("Value \\(x");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Value ",
              },
              {
                type: "inlineMath",
                value: "x",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
              },
            ],
          },
        ],
      },
    });
    expect(session.finalize().ast).toEqual(parseMarkdown("Value \\(x").ast);
  });

  it("suppresses a split parenthesized inline math opener until math content arrives", () => {
    const session = createLegacySession();
    const streaming = session.append("Value \\(");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Value ",
              },
            ],
          },
        ],
      },
    });
    expect(session.append("x").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Value ",
            },
            {
              type: "inlineMath",
              value: "x",
              data: {
                mistralMarkdown: {
                  unfinished: true,
                  optimistic: true,
                },
              },
            },
          ],
        },
      ],
    });
    expect(session.finalize().ast).toEqual(parseMarkdown("Value \\(x").ast);
  });

  it("optimistically closes streamed emphasis so formatting does not flash", () => {
    const session = createLegacySession();
    const streaming = session.append("*italic");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "emphasis",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
                children: [
                  {
                    type: "text",
                    value: "italic",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(session.finalize().ast).toEqual(parseMarkdown("*italic").ast);
  });

  it("may project optimistic strong during streaming and collapse back to text on finalize", () => {
    const session = createLegacySession();
    const streaming = session.append("**foo");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "strong",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
                children: [
                  {
                    type: "text",
                    value: "foo",
                  },
                ],
              },
            ],
          },
        ],
      },
    });

    expect(session.finalize().ast).toEqual(parseMarkdown("**foo").ast);
  });

  it.each([
    {
      chunks: ["**Optimistic projection", "*"],
      source: "**Optimistic projection*",
      text: "Optimistic projection",
    },
    {
      chunks: ["**Some ", "*"],
      source: "**Some *",
      text: "Some *",
    },
    {
      chunks: ["**Structural sharing", "*"],
      source: "**Structural sharing*",
      text: "Structural sharing",
    },
    {
      chunks: ["__Some ", "_"],
      source: "__Some _",
      text: "Some _",
    },
    {
      chunks: ["__Structural sharing", "_"],
      source: "__Structural sharing_",
      text: "Structural sharing",
    },
  ])(
    "suppresses ambiguous trailing strong delimiter text in optimistic projection: $source",
    ({ chunks, source, text }) => {
      const session = createLegacySession();
      let streaming = session.append(chunks[0] ?? "");
      streaming = session.append(chunks[1] ?? "");

      expect(streaming.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "strong",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
                children: [
                  {
                    type: "text",
                    value: text,
                  },
                ],
              },
            ],
          },
        ],
      });
      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each(["Use *", "Use **", "Use _", "Use __"])(
    "suppresses dangling inline opener markers during optimistic streaming: %s",
    (source) => {
      const session = createLegacySession();

      expect(session.append(source).ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Use ",
              },
            ],
          },
        ],
      });
      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each([
    {
      chunks: ["\n", "**", "Bold", "**", "\n"],
      name: "asterisk strong runs",
      nodeType: "strong",
      source: "\n**Bold**\n",
      text: "Bold",
    },
    {
      chunks: ["\n", "__", "Bold", "__", "\n"],
      name: "underscore strong runs",
      nodeType: "strong",
      source: "\n__Bold__\n",
      text: "Bold",
    },
  ])(
    "keeps streamed delimiter formatting visible when the opener arrives before the text: $name",
    ({ chunks, nodeType, source, text }) => {
      const session = createLegacySession();

      session.append(chunks[0] ?? "");
      session.append(chunks[1] ?? "");
      const optimistic = session.append(chunks[2] ?? "");

      expect(optimistic).toMatchObject({
        finalized: false,
        ast: {
          children: [
            {
              type: "paragraph",
              children: [
                {
                  type: nodeType,
                  data: {
                    mistralMarkdown: {
                      unfinished: true,
                      optimistic: true,
                    },
                  },
                  children: [{ type: "text", value: text }],
                },
              ],
            },
          ],
        },
      });

      const resolved = session.append(chunks[3] ?? "");

      expect(resolved.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: nodeType,
                children: [{ type: "text", value: text }],
              },
            ],
          },
        ],
      });

      session.append(chunks[4] ?? "");

      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each([
    {
      chunks: ["\n", "&", "amp;", "\n"],
      source: "\n&amp;\n",
      value: "&",
    },
    {
      chunks: ["\n", "&", "copy;", "\n"],
      source: "\n&copy;\n",
      value: "©",
    },
    {
      chunks: ["\n", "&", "#123;", "\n"],
      source: "\n&#123;\n",
      value: "{",
    },
    {
      chunks: ["\n", "&", "#x41;", "\n"],
      source: "\n&#x41;\n",
      value: "A",
    },
  ])(
    "upgrades split character references when the suffix arrives: $source",
    ({ chunks, source, value }) => {
      const session = createLegacySession();

      session.append(chunks[0] ?? "");
      session.append(chunks[1] ?? "");
      const resolved = session.append(chunks[2] ?? "");

      expect(resolved.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [{ type: "text", value }],
          },
        ],
      });

      session.append(chunks[3] ?? "");

      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each([
    {
      chunks: ["\n", "!", "[", "alt", "](/img.png)", "\n"],
      resolveAfterChunkCount: 5,
      source: "\n![alt](/img.png)\n",
      textPrefix: "",
    },
    {
      chunks: ["Look ", "!", "[", "alt", "](/img.png)"],
      resolveAfterChunkCount: 5,
      source: "Look ![alt](/img.png)",
      textPrefix: "Look ",
    },
  ])(
    "upgrades split image openers when [ arrives later: $source",
    ({ chunks, resolveAfterChunkCount, source, textPrefix }) => {
      const session = createLegacySession();
      let resolved;

      for (let index = 0; index < chunks.length; index += 1) {
        const snapshot = session.append(chunks[index] ?? "");

        if (index + 1 === resolveAfterChunkCount) {
          resolved = snapshot;
        }
      }

      expect(resolved).toBeDefined();

      expect(resolved?.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children:
              textPrefix.length === 0
                ? [
                    {
                      type: "image",
                      alt: "alt",
                      url: "/img.png",
                    },
                  ]
                : [
                    {
                      type: "text",
                      value: textPrefix,
                    },
                    {
                      type: "image",
                      alt: "alt",
                      url: "/img.png",
                    },
                  ],
          },
        ],
      });

      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each([
    {
      chunks: ["[x]", "(y)"],
      source: "[x](y)",
    },
    {
      chunks: ["[x](", "y)"],
      source: "[x](y)",
    },
    {
      chunks: ["Look [x]", "(y)"],
      source: "Look [x](y)",
    },
    {
      chunks: ["![alt]", "(/img.png)"],
      source: "![alt](/img.png)",
    },
    {
      chunks: ["![a](", "<b>)"],
      source: "![a](<b>)",
    },
    {
      chunks: ["![a]", "(<b>)"],
      source: "![a](<b>)",
    },
  ])(
    "reparses streamed link and image labels when the destination arrives later: $source",
    ({ chunks, source }) => {
      const session = createLegacySession();

      session.append(chunks[0] ?? "");
      const resolved = session.append(chunks[1] ?? "");

      expect(resolved.ast).toMatchObject(parseMarkdown(source).ast);
      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each([
    {
      chunks: ["www", ".example.com"],
      source: "www.example.com",
      url: "http://www.example.com",
      value: "www.example.com",
    },
    {
      chunks: ["www.example.com", "/docs"],
      source: "www.example.com/docs",
      url: "http://www.example.com/docs",
      value: "www.example.com/docs",
    },
    {
      chunks: ["http", "://example.com"],
      source: "http://example.com",
      url: "http://example.com",
      value: "http://example.com",
    },
    {
      chunks: ["http://example.com", "/docs"],
      source: "http://example.com/docs",
      url: "http://example.com/docs",
      value: "http://example.com/docs",
    },
    {
      chunks: ["http:", "//example.com"],
      source: "http://example.com",
      url: "http://example.com",
      value: "http://example.com",
    },
    {
      chunks: ["http:/", "/example.com"],
      source: "http://example.com",
      url: "http://example.com",
      value: "http://example.com",
    },
    {
      chunks: ["a", "@b.com"],
      source: "a@b.com",
      url: "mailto:a@b.com",
      value: "a@b.com",
    },
    {
      chunks: ["a@", "b.com"],
      source: "a@b.com",
      url: "mailto:a@b.com",
      value: "a@b.com",
    },
    {
      chunks: ["mailto:user", "@example.com"],
      source: "mailto:user@example.com",
      url: "mailto:user@example.com",
      value: "mailto:user@example.com",
    },
    {
      chunks: ["mailto:", "user@example.com"],
      source: "mailto:user@example.com",
      url: "mailto:user@example.com",
      value: "mailto:user@example.com",
    },
    {
      chunks: ["a.b-c_", "d@a.b"],
      source: "a.b-c_d@a.b",
      url: "mailto:a.b-c_d@a.b",
      value: "a.b-c_d@a.b",
    },
  ])(
    "upgrades trailing literal autolinks when the rest of the token streams in: $source",
    ({ chunks, source, url, value }) => {
      const session = createLegacySession();

      session.append(chunks[0] ?? "");
      const resolved = session.append(chunks[1] ?? "");

      expect(resolved.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "link",
                url,
                children: [{ type: "text", value }],
              },
            ],
          },
        ],
      });
      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it.each([
    {
      source: "Foo\n    ***\n",
      splitIndex: 5,
    },
    {
      source:
        "<table>\n  <tr>\n    <td>\n           hi\n    </td>\n  </tr>\n</table>\n\nokay.\n",
      splitIndex: 9,
    },
    {
      source: "foo\n    # bar\n",
      splitIndex: 5,
    },
    {
      source:
        "<table><tr><td>\n<pre>\n**Hello**,\n\n_world_.\n</pre>\n</td></tr></table>\n",
      splitIndex: 46,
    },
    {
      source: "# foo *bar* \\*baz\\*\n",
      splitIndex: 11,
    },
    {
      source: "&#9;foo\n",
      splitIndex: 4,
    },
    {
      source: "&#9;foo\n",
      splitIndex: 5,
    },
    {
      source: "` `` `\n",
      splitIndex: 3,
    },
    {
      source: "<del>*foo*</del>\n",
      splitIndex: 7,
    },
    {
      source: "\\\\*emphasis*\n",
      splitIndex: 2,
    },
    {
      source: "пристаням_стремятся_\n",
      splitIndex: 9,
    },
    {
      source: "*foo [bar](/url)*\n",
      splitIndex: 10,
    },
    {
      source: "http://example.com\n",
      splitIndex: 15,
    },
    {
      source: "a.b-c_d@a.b\n",
      splitIndex: 6,
    },
    {
      source: "`<http://foo.bar.`baz>`\n",
      splitIndex: 19,
    },
  ])(
    "matches one-shot parsing after finalization for representative split regressions: %j",
    ({ source, splitIndex }) => {
      expectFinalIncrementalParity(source, splitIndex);
    },
  );

  it("optimistically closes streamed inline code spans", () => {
    const session = createLegacySession();
    const streaming = session.append("Use `getData(");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Use ",
              },
              {
                type: "inlineCode",
                value: "getData(",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
              },
            ],
          },
        ],
      },
    });
    expect(session.finalize().ast).toEqual(parseMarkdown("Use `getData(").ast);
  });

  it("keeps optimistic inline formatting visible inside streamed headings", () => {
    const session = createLegacySession();
    const streaming = session.append("## Title *ital");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "heading",
            depth: 2,
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "text",
                value: "Title ",
              },
              {
                type: "emphasis",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
                children: [
                  {
                    type: "text",
                    value: "ital",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("keeps optimistic strong visible inside streamed block quotes", () => {
    const session = createLegacySession();
    const streaming = session.append("> **Par");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "blockquote",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "paragraph",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
                children: [
                  {
                    type: "strong",
                    data: {
                      mistralMarkdown: {
                        unfinished: true,
                        optimistic: true,
                      },
                    },
                    children: [
                      {
                        type: "text",
                        value: "Par",
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("keeps optimistic strong visible inside streamed list items", () => {
    const session = createLegacySession();

    session.append("# Re");
    session.append("lease ");
    session.append("plan\n\n");
    session.append("## ");
    session.append("What ");
    session.append("changed\n");
    const streaming = session.append("- **Par");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "heading",
            depth: 1,
          },
          {
            type: "heading",
            depth: 2,
          },
          {
            type: "list",
            children: [
              {
                type: "listItem",
                children: [
                  {
                    type: "paragraph",
                    children: [
                      {
                        type: "strong",
                        data: {
                          mistralMarkdown: {
                            unfinished: true,
                            optimistic: true,
                          },
                        },
                        children: [
                          {
                            type: "text",
                            value: "Par",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("suppresses header-only open tables until the first body row starts", () => {
    const session = createLegacySession();
    const hidden = session.append("Before\n\n| Col |\n| -");

    expect(hidden).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Before",
              },
            ],
          },
        ],
      },
    });

    const revealed = session.append("-- |\n| val");

    expect(revealed.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
        {
          type: "table",
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "Col",
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "val",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(session.finalize().ast).toEqual(
      parseMarkdown("Before\n\n| Col |\n| --- |\n| val").ast,
    );
  });

  it("suppresses a streamed table header until the delimiter row starts", () => {
    const session = createLegacySession();
    const hiddenHeader = session.append("Before\n\n| Phase | Status |\n");

    expect(hiddenHeader).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Before",
              },
            ],
          },
        ],
      },
    });

    const hiddenDelimiter = session.append("| :--- | :--- |\n");

    expect(hiddenDelimiter.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
      ],
    });

    const revealed = session.append("| Parser | fast");

    expect(revealed.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
        {
          type: "table",
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "Phase",
                    },
                  ],
                },
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "Status",
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "Parser",
                    },
                  ],
                },
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "fast",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(session.finalize().ast).toEqual(
      parseMarkdown(
        "Before\n\n| Phase | Status |\n| :--- | :--- |\n| Parser | fast",
      ).ast,
    );
  });

  it.each(["|", "| ", "| |", " |", " | "])(
    "suppresses dangling table row starters while streaming: %s",
    (rowStart) => {
      const session = createLegacySession();

      expect(session.append(`Before\n\n${rowStart}`).ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Before",
              },
            ],
          },
        ],
      });
    },
  );

  it("keeps optimistic table projection stable across char-by-char and split cuts", () => {
    const source =
      "Before\n\n| Phase | Status |\n| :--- | :--- |\n| Parser | fast |\n| Streaming | live";
    const headerLine = "| Phase | Status |\n";
    const delimiterLine = "| :--- | :--- |\n";
    const headerEnd = source.indexOf(headerLine) + headerLine.length;
    const delimiterEnd = source.indexOf(delimiterLine) + delimiterLine.length;
    const danglingRowStart = source.indexOf("\n| Streaming") + 2;
    const secondRowReveal = source.indexOf("\n| Streaming") + 4;

    expect(
      createLegacySession().append(source.slice(0, headerEnd)).ast,
    ).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
      ],
    });

    expect(
      createLegacySession().append(source.slice(0, delimiterEnd)).ast,
    ).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
      ],
    });

    expect(
      createLegacySession().append(source.slice(0, danglingRowStart)).ast,
    ).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
        {
          type: "table",
          children: [
            {
              type: "tableRow",
            },
            {
              type: "tableRow",
            },
          ],
        },
      ],
    });

    expect(
      createLegacySession().append(source.slice(0, secondRowReveal)).ast,
    ).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "Before",
            },
          ],
        },
        {
          type: "table",
          children: [
            {
              type: "tableRow",
            },
            {
              type: "tableRow",
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "S",
                    },
                  ],
                },
                {
                  type: "tableCell",
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });

    expectStreamingProjectionParityAcrossCuts(source);
  }, 15_000);

  it("reuses unchanged table rows when a table gains a row", () => {
    const session = createLegacySession();
    const first = session.append("| A |\n| - |\n| x |\n");
    const second = session.append("| y |\n");
    const firstTable = first.ast.children[0];
    const secondTable = second.ast.children[0];

    expect(firstTable?.type).toBe("table");
    expect(secondTable?.type).toBe("table");

    if (firstTable?.type !== "table" || secondTable?.type !== "table") {
      return;
    }

    expect(secondTable.children[1]).toBe(firstTable.children[1]);
    expect(secondTable.children).toHaveLength(3);
  });

  it("suppresses trailing paragraph lines that look like a partial table start", () => {
    const session = createLegacySession();
    const streaming = session.append("Lead paragraph\n| Col |\n|");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "text",
                value: "Lead paragraph",
              },
            ],
          },
        ],
      },
    });

    expect(session.finalize().ast).toEqual(
      parseMarkdown("Lead paragraph\n| Col |\n|").ast,
    );
  });

  it("suppresses dangling open table body rows until they gain cell content", () => {
    const session = createLegacySession();
    const hidden = session.append("| Col |\n| --- |\n|");

    expect(hidden).toMatchObject({
      finalized: false,
      ast: {
        children: [],
      },
    });

    const revealed = session.append(" val");

    expect(revealed.ast).toMatchObject({
      children: [
        {
          type: "table",
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "Col",
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "val",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(session.finalize().ast).toEqual(
      parseMarkdown("| Col |\n| --- |\n| val").ast,
    );
  });

  it("keeps completed table rows visible while suppressing a new dangling row", () => {
    const session = createLegacySession();
    const streaming = session.append("| Col |\n| --- |\n| first |\n|");

    expect(streaming.ast).toMatchObject({
      children: [
        {
          type: "table",
          data: {
            mistralMarkdown: {
              unfinished: true,
              optimistic: true,
            },
          },
          children: [
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "Col",
                    },
                  ],
                },
              ],
            },
            {
              type: "tableRow",
              children: [
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "first",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(session.finalize().ast).toEqual(
      parseMarkdown("| Col |\n| --- |\n| first |\n|").ast,
    );
  });

  it("keeps optimistic inline formatting visible inside open table cells", () => {
    const session = createLegacySession();
    const streaming = session.append("| Col |\n| --- |\n| *dat");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "table",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
            children: [
              {
                type: "tableRow",
                children: [
                  {
                    type: "tableCell",
                    children: [
                      {
                        type: "text",
                        value: "Col",
                      },
                    ],
                  },
                ],
              },
              {
                type: "tableRow",
                children: [
                  {
                    type: "tableCell",
                    children: [
                      {
                        type: "emphasis",
                        data: {
                          mistralMarkdown: {
                            unfinished: true,
                            optimistic: true,
                          },
                        },
                        children: [
                          {
                            type: "text",
                            value: "dat",
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    });
  });

  it("optimistically closes streamed link destinations once the label is explicit", () => {
    const session = createLegacySession();
    const streaming = session.append("Visit [our site](https://exa");

    expect(streaming).toMatchObject({
      finalized: false,
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Visit ",
              },
              {
                type: "link",
                url: "https://exa",
                data: {
                  mistralMarkdown: {
                    unfinished: true,
                    optimistic: true,
                  },
                },
                children: [
                  {
                    type: "text",
                    value: "our site",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(session.finalize().ast).toEqual(
      parseMarkdown("Visit [our site](https://exa").ast,
    );
  });

  it("suppresses partial link label syntax during optimistic streaming", () => {
    const session = createLegacySession();

    expect(session.append("Visit [our").ast.children).toMatchObject([
      { children: [{ type: "text", value: "Visit our" }] },
    ]);

    expect(session.append(" site").ast.children).toMatchObject([
      { children: [{ type: "text", value: "Visit our site" }] },
    ]);

    expect(session.append("]").ast.children).toMatchObject([
      { children: [{ type: "text", value: "Visit our site" }] },
    ]);

    expect(session.append("(https://exa").ast.children).toMatchObject([
      {
        children: [
          {
            type: "text",
            value: "Visit ",
          },
          {
            type: "link",
            url: "https://exa",
            children: [
              {
                type: "text",
                value: "our site",
              },
            ],
          },
        ],
      },
    ]);

    expect(session.finalize().ast).toEqual(
      parseMarkdown("Visit [our site](https://exa").ast,
    );
  });

  it("suppresses partial link label syntax after formatted inline prefixes", () => {
    expect(
      createLegacySession().append("Use `x` [docs]").ast.children,
    ).toMatchObject([
      {
        children: [
          {
            type: "text",
            value: "Use ",
          },
          {
            type: "inlineCode",
            value: "x",
          },
          {
            type: "text",
            value: " docs",
          },
        ],
      },
    ]);
  });

  it("suppresses partial link label syntax after resolved links", () => {
    expect(
      createLegacySession().append("[ready](/url) and [pending]").ast.children,
    ).toMatchObject([
      {
        children: [
          {
            type: "link",
            url: "/url",
            children: [{ type: "text", value: "ready" }],
          },
          {
            type: "text",
            value: " and pending",
          },
        ],
      },
    ]);
  });

  it("keeps reference-looking trailing labels literal while streaming", () => {
    expect(createLegacySession().append("[Baz][Foo]").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "[Baz][Foo]",
            },
          ],
        },
      ],
    });
  });

  it.each([
    "Visit \\[our site](https://exa",
    "Visit !\\[our site](https://exa",
  ])(
    "does not synthesize a projected link when the opener is escaped: %s",
    (source) => {
      const session = createLegacySession();
      const exact = parseMarkdown(source).ast.children[0];

      expect(session.append(source).ast).toMatchObject({
        children: [
          {
            children: exact?.type === "paragraph" ? exact.children : [],
          },
        ],
      });
    },
  );

  it("does not synthesize formatting for a dangling closer without an opener", () => {
    const session = createLegacySession();

    expect(session.append("text*").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "text",
              value: "text*",
            },
          ],
        },
      ],
    });
  });

  it.each([
    {
      finalSource: "$x$",
      prefix: "",
    },
    {
      finalSource: "Text $x$",
      prefix: "Text ",
    },
  ])(
    "upgrades inline dollar math when the opener, payload, and closer stream separately: $finalSource",
    ({ finalSource, prefix }) => {
      const session = createLegacySession();

      if (prefix.length > 0) {
        session.append(prefix);
      }

      const afterOpener = session.append("$");
      const afterPayload = session.append("x");
      const afterCloser = session.append("$");

      expect(afterOpener.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children:
              prefix.length === 0
                ? []
                : [
                    {
                      type: "text",
                      value: prefix,
                    },
                  ],
          },
        ],
      });
      expect(afterPayload.ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children:
              prefix.length === 0
                ? []
                : [
                    {
                      type: "text",
                      value: prefix,
                    },
                  ],
          },
        ],
      });
      expect(afterCloser.ast).toMatchObject(parseMarkdown(finalSource).ast);
      expect(session.finalize().ast).toEqual(parseMarkdown(finalSource).ast);
    },
  );

  it("suppresses unfinished dollar math inside streamed table cells", () => {
    const session = createLegacySession();

    expect(
      session.append(
        "| Capability | Status | Notes |\n| :--- | :---: | :--- |\n| Math | done | supports $",
      ).ast,
    ).toMatchObject({
      children: [
        {
          type: "table",
          children: [
            {},
            {
              type: "tableRow",
              children: [
                {},
                {},
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "supports ",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const snapshot = session.append("a^2 + b");

    expect(snapshot.ast).toMatchObject({
      children: [
        {
          type: "table",
          children: [
            {},
            {
              type: "tableRow",
              children: [
                {},
                {},
                {
                  type: "tableCell",
                  children: [
                    {
                      type: "text",
                      value: "supports ",
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
  });

  it.each(["Price is $10", "Price is $10.99", "Price is $10 + tax"])(
    "suppresses unfinished currency-looking dollar spans while streaming: %s",
    (source) => {
      expect(createLegacySession().append(source).ast).toMatchObject({
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "Price is ",
              },
            ],
          },
        ],
      });
    },
  );

  it("upgrades parenthesized inline math when the opener streams across chunk boundaries", () => {
    const session = createLegacySession();

    session.append("Value \\");
    session.append("(");
    session.append("x");
    const afterCloser = session.append("\\)");

    expect(afterCloser.ast).toMatchObject(parseMarkdown("Value \\(x\\)").ast);
    expect(session.finalize().ast).toEqual(parseMarkdown("Value \\(x\\)").ast);
  });

  it.each([
    "Before math such as \\( E = mc^2 \\) while streaming.",
    "Before math such as \\( E = mc^2 \\), then punctuation.",
  ])(
    "keeps parenthesized inline math stable across every streamed character: %s",
    (source) => {
      expectStreamingProjectionParityAcrossCuts(source);
    },
  );

  it("holds ambiguous parenthesized inline math delimiters instead of flashing raw syntax", () => {
    const session = createLegacySession();

    expect(session.append("Before math such as \\").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Before math such as " }],
        },
      ],
    });

    expect(session.append("(").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Before math such as " }],
        },
      ],
    });

    expect(session.append(" ").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Before math such as " }],
        },
      ],
    });

    expect(session.append("E = mc^2").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Before math such as " },
            { type: "inlineMath", value: "E = mc^2" },
          ],
        },
      ],
    });

    expect(session.append(" \\").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Before math such as " },
            { type: "inlineMath", value: "E = mc^2" },
          ],
        },
      ],
    });

    expect(session.append(")").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            { type: "text", value: "Before math such as " },
            { type: "inlineMath", value: "E = mc^2" },
          ],
        },
      ],
    });
  });

  it.each(["Value $x", "Value \\(x"])(
    "keeps unfinished inline math literal when the closer never arrives: %s",
    (source) => {
      const session = createLegacySession();

      session.append(source);

      expect(session.finalize().ast).toEqual(parseMarkdown(source).ast);
    },
  );

  it("upgrades unfinished inline links when the closer arrives later", () => {
    const session = createLegacySession();
    const beforeLabel = session.append("[");
    const beforeCloser = session.append("link");
    const afterCloser = session.append("](/url)");

    expect(beforeLabel).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "paragraph",
            children: [],
          },
        ],
      },
    });
    expect(beforeCloser).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "paragraph",
            children: [
              {
                type: "text",
                value: "link",
              },
            ],
          },
        ],
      },
    });
    expect(afterCloser).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
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
                    value: "link",
                  },
                ],
              },
            ],
          },
        ],
      },
    });
    expect(session.finalize().ast).toEqual(parseMarkdown("[link](/url)").ast);
  });

  it.each([
    "Links like [docs](https://docs.mistral.ai), and more text.",
    "Links like [docs](<https://docs.mistral.ai>), and more text.",
    "Image ![alt](https://docs.mistral.ai/image.png), and more text.",
  ])(
    "keeps streamed links stable after the destination closer is followed by punctuation: %s",
    (source) => {
      expectStreamingProjectionParityAcrossCuts(source);
    },
  );

  it("keeps stable inline prefixes shared while an unresolved link label grows", () => {
    const session = createLegacySession();
    const beforeLabel = session.append("*prefix* [");
    const middle = session.append("alpha");
    const afterLabel = session.append(" beta");

    const beforeParagraph = beforeLabel.ast.children[0];
    const middleParagraph = middle.ast.children[0];
    const afterParagraph = afterLabel.ast.children[0];

    expect(beforeParagraph?.type).toBe("paragraph");
    expect(middleParagraph?.type).toBe("paragraph");
    expect(afterParagraph?.type).toBe("paragraph");

    if (
      beforeParagraph?.type === "paragraph" &&
      middleParagraph?.type === "paragraph" &&
      afterParagraph?.type === "paragraph"
    ) {
      expect(middleParagraph.children[0]).toBe(beforeParagraph.children[0]);
      expect(afterParagraph.children[0]).toBe(beforeParagraph.children[0]);
    }

    expect(afterLabel.ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [
                {
                  type: "text",
                  value: "prefix",
                },
              ],
            },
            {
              type: "text",
              value: " alpha beta",
            },
          ],
        },
      ],
    });
  });

  it("keeps optimistic inline formatting visible inside a streamed link label", () => {
    const session = createLegacySession();
    let source = "";

    source += "[";
    expect(session.append("[").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [],
        },
      ],
    });

    source += "*alpha";
    expect(session.append("*alpha").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [
                {
                  type: "text",
                  value: "alpha",
                },
              ],
            },
          ],
        },
      ],
    });

    source += "* `code`";
    expect(session.append("* `code`").ast).toMatchObject({
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "emphasis",
              children: [
                {
                  type: "text",
                  value: "alpha",
                },
              ],
            },
            {
              type: "text",
              value: " ",
            },
            {
              type: "inlineCode",
              value: "code",
            },
          ],
        },
      ],
    });

    source += "](/url)";
    expect(session.append("](/url)").ast).toMatchObject(
      parseMarkdown(source).ast,
    );
  });

  it("tracks unfinished block math until the fence closes", () => {
    const session = createLegacySession();
    const streaming = session.append("$$\nx");

    expect(streaming).toMatchObject({
      finalized: false,
      diagnostics: [
        {
          code: "unfinished-input",
          offset: 0,
        },
      ],
      ast: {
        children: [
          {
            type: "math",
            value: "x",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });

    expect(session.append("\n$$\n")).toMatchObject({
      finalized: false,
      diagnostics: [],
      ast: {
        children: [
          {
            type: "math",
            value: "x\n",
            meta: null,
          },
        ],
      },
    });
  });

  it("upgrades dollar block math when the opener streams across chunk boundaries", () => {
    const session = createLegacySession();

    session.append("$");
    const afterSecondDollar = session.append("$");
    const afterBody = session.append("\nx");
    const afterCloser = session.append("\n$$\n");

    expect(afterSecondDollar).toMatchObject({
      ast: {
        children: [
          {
            type: "math",
            value: "",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });
    expect(afterBody).toMatchObject({
      ast: {
        children: [
          {
            type: "math",
            value: "x",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });
    expect(afterCloser.ast).toEqual(parseMarkdown("$$\nx\n$$\n").ast);
  });

  it("upgrades bracketed block math when the opener streams across chunk boundaries", () => {
    const session = createLegacySession();

    session.append("\\");
    const afterBracket = session.append("[");
    const afterBody = session.append("\nx");
    const afterCloser = session.append("\n\\]\n");

    expect(afterBracket).toMatchObject({
      ast: {
        children: [
          {
            type: "math",
            value: "",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });
    expect(afterBody).toMatchObject({
      ast: {
        children: [
          {
            type: "math",
            value: "x",
            data: {
              mistralMarkdown: {
                unfinished: true,
                optimistic: true,
              },
            },
          },
        ],
      },
    });
    expect(afterCloser.ast).toEqual(parseMarkdown("\\[\nx\n\\]\n").ast);
  });

  it.each([
    [
      "bracketed display math with indented closer in a list",
      [
        "Here's how you can calculate NDCG in this scenario:",
        "",
        "1. **Discounted Cumulative Gain (DCG):**",
        "   - For a single relevant item at position \\( p \\), the DCG is calculated as:",
        "\\[",
        "\\text{DCG}_p = \\frac{1}{\\log_2(p + 1)}",
        "     \\]",
        "",
        "2. **Ideal Discounted Cumulative Gain (IDCG):**",
      ].join("\n"),
    ],
    ["dollar display math with indented closer", "$$\nx\n     $$\nAfter"],
    [
      "bracketed display math inside a block quote with indented closer",
      "> \\[\n> x\n>      \\]\n> After",
    ],
    [
      "bracketed display math followed immediately by the next ordered item",
      ["1. First", "\\[", "x", "     \\]", "2. Second"].join("\n"),
    ],
  ])("keeps finalized incremental parity for %s", (_name, source) => {
    const closerIndex = source.indexOf("\\]");
    const dollarCloserIndex = source.lastIndexOf("$$");
    const delimiterIndex = closerIndex > 0 ? closerIndex : dollarCloserIndex;

    for (const splitIndex of [
      Math.max(1, source.indexOf("\n") + 1),
      delimiterIndex,
      Math.min(source.length - 1, delimiterIndex + 1),
    ]) {
      expectFinalIncrementalParity(source, splitIndex);
    }
  });

  it("keeps closed inline math children shared across later appends and finalization", () => {
    const session = createLegacySession();
    const initial = session.append("Text \\(x\\)");
    const afterTail = session.append(" more");
    const finalized = session.finalize();

    const initialParagraph = initial.ast.children[0];
    const afterTailParagraph = afterTail.ast.children[0];
    const finalizedParagraph = finalized.ast.children[0];

    expect(initialParagraph?.type).toBe("paragraph");
    expect(afterTailParagraph?.type).toBe("paragraph");
    expect(finalizedParagraph?.type).toBe("paragraph");

    if (
      initialParagraph?.type === "paragraph" &&
      afterTailParagraph?.type === "paragraph" &&
      finalizedParagraph?.type === "paragraph"
    ) {
      expect(afterTailParagraph.children[0]).toBe(initialParagraph.children[0]);
      expect(afterTailParagraph.children[1]).toBe(initialParagraph.children[1]);
      expect(finalizedParagraph.children[1]).toBe(initialParagraph.children[1]);
    }
  });

  it("keeps closed block math nodes shared across later appends and finalization", () => {
    const session = createLegacySession();
    const initial = session.append("\\[\nx\n\\]\n");
    const afterTail = session.append("\nTail\n");
    const finalized = session.finalize();

    expect(afterTail.ast.children[0]).toBe(initial.ast.children[0]);
    expect(finalized.ast.children[0]).toBe(initial.ast.children[0]);
    expect(finalized.ast).toEqual(parseMarkdown("\\[\nx\n\\]\n\nTail\n").ast);
  });
});
