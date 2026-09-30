import { parseHtmlTagStart, scanCompleteOpeningHtmlTag } from "../html-scan.js";
import { renderMarkdownAstToHtml } from "../html.js";
import { parseMarkdown } from "../parse.js";
import type { SpecAdapter, SpecExample, SpecEvaluation } from "./types.js";

const TASK_LIST_SECTIONS = new Set<string>([
  "Task lists",
  "Task list items (extension)",
]);

const SUPPORTED_SECTIONS = new Set<string>([
  "ATX headings",
  "Autolinks",
  "Autolinks (extension)",
  "Backslash escapes",
  "Blank lines",
  "Block quotes",
  "Code spans",
  "Disallowed Raw HTML (extension)",
  "Emphasis and strong emphasis",
  "Entity and numeric character references",
  "Fenced code blocks",
  "Footnote reference labels are href escaped",
  "Footnotes",
  "Hard line breaks",
  "HTML blocks",
  "Images",
  "Indented code blocks",
  "Inlines",
  "Interop",
  "Link reference definitions",
  "Links",
  "List items",
  "Lists",
  "Paragraphs",
  "Precedence",
  "Raw HTML",
  "Setext headings",
  "Soft line breaks",
  "Strikethrough (extension)",
  "Strikethroughs",
  "Tables (extension)",
  "Table cell count mismatches",
  "Tables",
  "Task lists",
  "Task list items (extension)",
  "Tabs",
  "Textual content",
  "Thematic breaks",
  "When a footnote is used multiple times, we insert multiple backrefs.",
  "a table can be recognised when separated from a paragraph of text without an empty line",
  "Autolinks",
  "Embedded HTML",
  "Embedded pipes",
  "Escaping",
  "HTML tag filter",
  "Interaction with emphasis",
  "Oddly-formatted markers",
  "Reference-style links",
  "Sequential cells",
]);

const DIALECT_SKIP_REASONS = new Map<string, string>([
  [
    "commonmark:12",
    "Deliberate dialect overlap: the universal parser treats `\\[` as math-opening syntax rather than a plain backslash escape sequence.",
  ],
  [
    "commonmark:14",
    "Deliberate dialect overlap: the universal parser recognizes `\\[`...`\\]` as block math instead of keeping that sequence literal.",
  ],
  [
    "commonmark:565",
    "Deliberate dialect overlap: the universal parser recognizes `\\[`...`\\]` as block math instead of keeping that sequence literal.",
  ],
  [
    "commonmark:604",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "commonmark:610",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "commonmark:613",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "commonmark:614",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "gfm:308",
    "Deliberate dialect overlap: the universal parser treats `\\[` as math-opening syntax rather than a plain backslash escape sequence.",
  ],
  [
    "gfm:310",
    "Deliberate dialect overlap: the universal parser recognizes `\\[`...`\\]` as block math instead of keeping that sequence literal.",
  ],
  [
    "gfm:571",
    "Deliberate dialect overlap: the universal parser recognizes `\\[`...`\\]` as block math instead of keeping that sequence literal.",
  ],
  [
    "gfm:610",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "gfm:616",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "gfm:619",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
  [
    "gfm:620",
    "Deliberate dialect overlap: the universal parser enables GFM autolink literals everywhere instead of only in extension-specific corpus cases.",
  ],
]);

function isSupportedExample(example: SpecExample): boolean {
  return SUPPORTED_SECTIONS.has(example.section);
}

function shouldUseGfmTagFilter(example: SpecExample): boolean {
  return (
    example.extensions.includes("tagfilter") ||
    example.section === "Disallowed Raw HTML (extension)" ||
    example.section === "HTML tag filter"
  );
}

function shouldNormalizeTaskListHtml(example: SpecExample): boolean {
  return TASK_LIST_SECTIONS.has(example.section);
}

function getDialectSkipReason(example: SpecExample): string | undefined {
  return DIALECT_SKIP_REASONS.get(`${example.suite}:${example.number}`);
}

function normalizeTaskListCheckboxHtml(html: string): string {
  let normalized = "";
  let segmentStart = 0;

  for (let index = 0; index < html.length; index += 1) {
    if (html[index] !== "<") {
      continue;
    }

    const tag = parseHtmlTagStart(html, index);

    if (tag?.closing || tag?.name !== "input") {
      continue;
    }

    const endIndex = scanCompleteOpeningHtmlTag(html, index);

    if (endIndex === null) {
      continue;
    }

    const tagText = html.slice(index, endIndex);

    if (
      !tagText.includes('type="checkbox"') ||
      !tagText.includes('disabled=""')
    ) {
      index = endIndex - 1;
      continue;
    }

    normalized += html.slice(segmentStart, index);
    normalized += tagText.includes('checked=""')
      ? '<input checked="" disabled="" type="checkbox">'
      : '<input disabled="" type="checkbox">';
    segmentStart = endIndex;
    index = endIndex - 1;
  }

  return segmentStart === 0 ? html : normalized + html.slice(segmentStart);
}

export const mistralSpecAdapter: SpecAdapter = {
  name: "mistral-markdown",

  evaluate(example: SpecExample): SpecEvaluation {
    if (!isSupportedExample(example)) {
      return {
        status: "not_implemented",
        message: `Section "${example.section}" is outside the current parser slice.`,
      };
    }

    const dialectSkipReason = getDialectSkipReason(example);

    if (dialectSkipReason !== undefined) {
      return {
        status: "skip",
        message: dialectSkipReason,
      };
    }

    const snapshot = parseMarkdown(example.markdown);
    const html = renderMarkdownAstToHtml(snapshot.ast, {
      collapseNestedStrong: example.suite !== "commonmark",
      gfmTagFilter: shouldUseGfmTagFilter(example),
    });
    const normalizedHtml = shouldNormalizeTaskListHtml(example)
      ? normalizeTaskListCheckboxHtml(html)
      : html;
    const normalizedExpectedHtml = shouldNormalizeTaskListHtml(example)
      ? normalizeTaskListCheckboxHtml(example.html)
      : example.html;

    if (example.html.trim() === "<IGNORE>") {
      return {
        status: "pass",
      };
    }

    if (normalizedHtml === normalizedExpectedHtml) {
      return {
        status: "pass",
      };
    }

    return {
      status: "fail",
      message: `Expected ${JSON.stringify(example.html)} but received ${JSON.stringify(html)}.`,
    };
  },
};
