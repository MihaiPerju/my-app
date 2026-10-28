import { describe, expect, it } from "vitest";

import {
  appendMarkdownChunk,
  createInitialMarkdownResult,
  finalizeMarkdownResult,
  parseMarkdown,
} from "../src/parse.ts";

describe("incremental parser state", () => {
  it("tracks unresolved bracket inline tails separately from block openness", () => {
    const result = appendMarkdownChunk(
      createInitialMarkdownResult(),
      "[label]\n\n",
    );

    expect(result.snapshot.diagnostics).toEqual([]);
    expect(result.state.pendingConstructs).toEqual([
      {
        kind: "inlineBracket",
        startOffset: 0,
      },
    ]);
  });

  it("keeps trailing reference definitions dirty until their line is closed", () => {
    const result = appendMarkdownChunk(
      createInitialMarkdownResult(),
      "[Foo\n  bar]: /u",
    );

    expect(result.snapshot.diagnostics).toEqual([]);
    expect(result.state.pendingConstructs).toEqual([
      {
        kind: "referenceDefinition",
        startOffset: 0,
      },
    ]);
    expect(result.state.reparseFromOffset).toBe(0);
  });

  it("retains cached lines only for the next dirty tail", () => {
    const result = appendMarkdownChunk(
      createInitialMarkdownResult(),
      "Done.\n\n[label]",
    );

    expect(result.state.pendingConstructs).toEqual([
      {
        kind: "paragraph",
        startOffset: 7,
      },
    ]);
    expect(result.state.reparseFromOffset).toBe(7);
    expect(result.state.lineCacheStartOffset).toBe(7);
    expect(result.state.lineCache).toHaveLength(1);
  });

  it("releases the parser workspace after finalization", () => {
    const result = finalizeMarkdownResult(
      appendMarkdownChunk(createInitialMarkdownResult(), "## Title\n\nBody"),
    );

    expect(result.snapshot.finalized).toBe(true);
    expect(result.state).toMatchObject({
      source: "",
      appendStartOffset: null,
      reparseFromOffset: 0,
      lineCache: [],
      lineCacheSourceLength: 0,
      lineCacheStartOffset: 0,
      pendingConstructs: [],
      blocks: [],
      referenceDefinitions: [],
      footnoteDefinitions: [],
    });
    expect(result.state.referenceDefinitionIndex.size).toBe(0);
    expect(result.state.footnoteDefinitionIndex.size).toBe(0);
  });

  it("keeps one-shot parsing aligned with the finalized default-state pipeline", () => {
    const source = "# Title\n\nVisit https://example.com and use $x$.\n";
    const incremental = finalizeMarkdownResult(
      appendMarkdownChunk(createInitialMarkdownResult(), source),
    );

    expect(parseMarkdown(source)).toEqual(incremental.snapshot);
  });

  it("keeps one-shot parsing aligned for GFM extensions too", () => {
    const source = "~~strike~~\n";
    const incremental = finalizeMarkdownResult(
      appendMarkdownChunk(createInitialMarkdownResult(), source),
    );

    expect(parseMarkdown(source)).toEqual(incremental.snapshot);
  });
});
