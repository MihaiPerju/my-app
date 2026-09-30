import { describe, expect, it } from "vitest";

import { renderMarkdownAstToHtml } from "../src/html.ts";
import { parseMarkdown } from "../src/index.ts";
import { commonmarkSubsetFixtures } from "./commonmark-subset.fixtures.ts";

describe("supported CommonMark examples", () => {
  it.each(commonmarkSubsetFixtures)(
    "matches CommonMark example $number",
    (example) => {
      const snapshot = parseMarkdown(example.markdown);

      expect(renderMarkdownAstToHtml(snapshot.ast)).toBe(example.html);
    },
  );
});
