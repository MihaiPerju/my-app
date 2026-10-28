import type { Nodes } from "mdast";
import { describe, expect, it } from "vitest";

import {
  createMarkdownSession,
  parseMarkdown,
  type UnstableMarkdownTransform,
} from "../src/index.ts";
import {
  htmlBreaksToMarkdownBreaks,
  liftSpecialUriLinks,
  llmCompatibilityTransforms,
  singleItemOrderedListsToParagraphs,
} from "../src/transforms.ts";

function createCustomElementNode(kind: string): Nodes {
  return {
    type: "custom-element",
    data: {
      element: {
        kind,
      },
    },
  } as unknown as Nodes;
}

function decodeKind(value: string): string | null {
  const marker = 'data-kind="';
  const start = value.indexOf(marker);

  if (start === -1) {
    return null;
  }

  const valueStart = start + marker.length;
  const valueEnd = value.indexOf('"', valueStart);

  return valueEnd === -1 ? null : value.slice(valueStart, valueEnd);
}

const customElementTransform = {
  parentTypes: ["root", "paragraph"],
  transform(children) {
    let next: Nodes[] | undefined;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const kind = child?.type === "html" ? decodeKind(child.value) : null;
      const replacement = kind === null ? child : createCustomElementNode(kind);

      if (replacement === child && next === undefined) {
        continue;
      }

      if (next === undefined) {
        next = children.slice(0, index);
      }

      if (replacement !== undefined) {
        next.push(replacement);
      }
    }

    return next ?? children;
  },
} satisfies UnstableMarkdownTransform;

const tableMetadataTransform = {
  parentTypes: ["root"],
  transform(children) {
    let next: Nodes[] | undefined;
    let pendingTitle: string | null = null;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];

      if (child?.type === "html") {
        const title = decodeKind(child.value);

        if (title !== null) {
          pendingTitle = title;
          if (next === undefined) {
            next = children.slice(0, index);
          }
          continue;
        }
      }

      if (child?.type === "table" && pendingTitle !== null) {
        if (next === undefined) {
          next = children.slice(0, index);
        }
        next.push({
          ...child,
          data: {
            ...child.data,
            tableMetadata: {
              title: pendingTitle,
            },
          },
        });
        pendingTitle = null;
        continue;
      }

      if (next !== undefined && child !== undefined) {
        next.push(child);
      }
    }

    return next ?? children;
  },
} satisfies UnstableMarkdownTransform;

const splitCustomElementTransform = {
  parentTypes: ["paragraph"],
  transform(children) {
    let next: Nodes[] | undefined;

    for (let index = 0; index < children.length; index += 1) {
      const child = children[index];
      const kind = child?.type === "html" ? decodeKind(child.value) : null;

      if (kind === null) {
        if (next !== undefined && child !== undefined) {
          next.push(child);
        }
        continue;
      }

      if (next === undefined) {
        next = children.slice(0, index);
      }
      next.push(createCustomElementNode(kind));
      next.push({
        type: "text",
        value: " decoded",
      });
    }

    return next ?? children;
  },
} satisfies UnstableMarkdownTransform;

describe("markdown transforms", () => {
  it("replaces html children before publication", () => {
    const snapshot = parseMarkdown(
      'Before <x-widget data-kind="image" /> after',
      {
        unstable_transforms: [customElementTransform],
      },
    );

    expect(snapshot.ast.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "text",
          value: "Before ",
        },
        {
          type: "custom-element",
          data: {
            element: {
              kind: "image",
            },
          },
        },
        {
          type: "text",
          value: " after",
        },
      ],
    });
  });

  it("keeps transform output out of incremental parser state", () => {
    const source = 'Before <x-widget data-kind="image" /> after';
    const session = createMarkdownSession({
      unstable_transforms: [customElementTransform],
    });

    for (let index = 1; index <= source.length; index += 1) {
      session.parse(source.slice(0, index), false);
    }

    expect(session.parse(source, true).ast).toEqual(
      parseMarkdown(source, { unstable_transforms: [customElementTransform] })
        .ast,
    );
  });

  it("supports sibling transforms such as table metadata", () => {
    const snapshot = parseMarkdown(
      '<table-title data-kind="Latency" />\n\n| Name | Value |\n| --- | ---: |\n| p50 | 12ms |\n',
      {
        unstable_transforms: [tableMetadataTransform],
      },
    );

    expect(snapshot.ast.children).toHaveLength(1);
    expect(snapshot.ast.children[0]).toMatchObject({
      type: "table",
      data: {
        tableMetadata: {
          title: "Latency",
        },
      },
    });
  });

  it("reuses transformed subtrees for unchanged raw subtrees", () => {
    const session = createMarkdownSession({
      unstable_transforms: [customElementTransform],
    });
    const first = session.parse(
      'Before <x-widget data-kind="image" /> after\n\nTail',
      false,
    );
    const second = session.parse(
      'Before <x-widget data-kind="image" /> after\n\nTail grows',
      false,
    );

    expect(second.ast.children[0]).toBe(first.ast.children[0]);
  });

  it("reuses stable raw subtrees when transforms expand a child", () => {
    const session = createMarkdownSession({
      unstable_transforms: [splitCustomElementTransform],
    });
    const first = session.parse(
      'Before <x-widget data-kind="image" /> after\n\nTail',
      false,
    );
    const second = session.parse(
      'Before <x-widget data-kind="image" /> after\n\nTail grows',
      false,
    );

    expect(second.ast.children[0]).toBe(first.ast.children[0]);
    expect(second.ast.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        {
          type: "text",
          value: "Before ",
        },
        {
          type: "custom-element",
        },
        {
          type: "text",
          value: " decoded",
        },
        {
          type: "text",
          value: " after",
        },
      ],
    });
  });

  it("keeps a standalone numbered line as a paragraph for LLM output", () => {
    const source = "Blah\n\n2. Liquidation du patrimoine\n\nBlah";

    expect(parseMarkdown(source).ast.children[1]).toMatchObject({
      type: "list",
      ordered: true,
      start: 2,
    });
    expect(
      parseMarkdown(source, {
        unstable_transforms: llmCompatibilityTransforms,
      }).ast.children,
    ).toMatchObject([
      {
        type: "paragraph",
        children: [{ type: "text", value: "Blah" }],
      },
      {
        type: "paragraph",
        children: [
          { type: "text", value: "2. " },
          { type: "text", value: "Liquidation du patrimoine" },
        ],
      },
      {
        type: "paragraph",
        children: [{ type: "text", value: "Blah" }],
      },
    ]);
  });

  it("preserves inline markup when normalizing a single-item ordered list", () => {
    const snapshot = parseMarkdown("12. **Bold** and *italic*", {
      unstable_transforms: [singleItemOrderedListsToParagraphs],
    });

    expect(snapshot.ast.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "12. " },
        {
          type: "strong",
          children: [{ type: "text", value: "Bold" }],
        },
        { type: "text", value: " and " },
        {
          type: "emphasis",
          children: [{ type: "text", value: "italic" }],
        },
      ],
    });
  });

  it("keeps multi-item and complex ordered lists unchanged", () => {
    const sources = [
      "2. First\n3. Second",
      "2. First paragraph\n\n   Second paragraph",
      "2. [x] Complete",
      "2. Parent\n   - Child",
      "- Unordered",
    ];

    for (const source of sources) {
      const parsed = parseMarkdown(source);
      const transformed = parseMarkdown(source, {
        unstable_transforms: [singleItemOrderedListsToParagraphs],
      });

      expect(transformed.ast).toEqual(parsed.ast);
    }
  });

  it("provides an LLM-oriented html break transform", () => {
    const snapshot = parseMarkdown(
      "First<br>Second<br />Third<br\t/>Fourth<BR>Fifth<Br />Sixth<br\n/>Seventh<BR\f/>Eighth",
      {
        unstable_transforms: [htmlBreaksToMarkdownBreaks],
      },
    );

    expect(snapshot.ast.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "First" },
        { type: "break" },
        { type: "text", value: "Second" },
        { type: "break" },
        { type: "text", value: "Third" },
        { type: "break" },
        { type: "text", value: "Fourth" },
        { type: "break" },
        { type: "text", value: "Fifth" },
        { type: "break" },
        { type: "text", value: "Sixth" },
        { type: "break" },
        { type: "text", value: "Seventh" },
        { type: "break" },
        { type: "text", value: "Eighth" },
      ],
    });
  });

  it("normalizes literal HTML breaks in inline parents", () => {
    const snapshot = parseMarkdown(
      [
        "# Heading<br>detail",
        "",
        "| **Header<br>detail** |",
        "| --- |",
        "| [First<BR>Second](https://example.com) *Third<Br />Fourth* ~~Fifth<br>Sixth~~ |",
      ].join("\n"),
      { unstable_transforms: llmCompatibilityTransforms },
    );

    expect(snapshot.ast.children).toMatchObject([
      {
        type: "heading",
        children: [
          { type: "text", value: "Heading" },
          { type: "break" },
          { type: "text", value: "detail" },
        ],
      },
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
                    type: "strong",
                    children: [
                      { type: "text", value: "Header" },
                      { type: "break" },
                      { type: "text", value: "detail" },
                    ],
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
                    type: "link",
                    children: [
                      { type: "text", value: "First" },
                      { type: "break" },
                      { type: "text", value: "Second" },
                    ],
                  },
                  { type: "text", value: " " },
                  {
                    type: "emphasis",
                    children: [
                      { type: "text", value: "Third" },
                      { type: "break" },
                      { type: "text", value: "Fourth" },
                    ],
                  },
                  { type: "text", value: " " },
                  {
                    type: "delete",
                    children: [
                      { type: "text", value: "Fifth" },
                      { type: "break" },
                      { type: "text", value: "Sixth" },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);
  });

  it("keeps non-break HTML unchanged in the html break transform", () => {
    const snapshot = parseMarkdown("First<br data-x>Second", {
      unstable_transforms: [htmlBreaksToMarkdownBreaks],
    });

    expect(snapshot.ast.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "First" },
        { type: "html", value: "<br data-x>" },
        { type: "text", value: "Second" },
      ],
    });
  });

  it("lifts special URI links out of root paragraphs", () => {
    const snapshot = parseMarkdown(
      "Before [Status card](component://abc123) after",
      {
        unstable_transforms: [
          liftSpecialUriLinks((uri) => uri.startsWith("component://")),
        ],
      },
    );

    expect(snapshot.ast.children).toMatchObject([
      {
        type: "paragraph",
        children: [{ type: "text", value: "Before " }],
      },
      {
        type: "specialUriLink",
        url: "component://abc123",
        data: {
          hName: "special-uri-link",
          hProperties: { href: "component://abc123" },
        },
        children: [{ type: "text", value: "Status card" }],
      },
      {
        type: "paragraph",
        children: [{ type: "text", value: " after" }],
      },
    ]);
  });

  it("keeps ordinary links inside paragraphs when lifting special URI links", () => {
    const snapshot = parseMarkdown("Before [Docs](https://example.com) after", {
      unstable_transforms: [
        liftSpecialUriLinks((uri) => uri.startsWith("component://")),
      ],
    });

    expect(snapshot.ast.children).toHaveLength(1);
    expect(snapshot.ast.children[0]).toMatchObject({
      type: "paragraph",
      children: [
        { type: "text", value: "Before " },
        { type: "link", url: "https://example.com" },
        { type: "text", value: " after" },
      ],
    });
  });

  it("lifts special URI links inside block containers", () => {
    const snapshot = parseMarkdown("> Intro [Card](component://abc123)", {
      unstable_transforms: [
        liftSpecialUriLinks((uri) => uri.startsWith("component://")),
      ],
    });

    expect(snapshot.ast.children[0]).toMatchObject({
      type: "blockquote",
      children: [
        {
          type: "paragraph",
          children: [{ type: "text", value: "Intro " }],
        },
        {
          type: "specialUriLink",
          url: "component://abc123",
          data: {
            hName: "special-uri-link",
            hProperties: { href: "component://abc123" },
          },
          children: [{ type: "text", value: "Card" }],
        },
      ],
    });
  });
});
