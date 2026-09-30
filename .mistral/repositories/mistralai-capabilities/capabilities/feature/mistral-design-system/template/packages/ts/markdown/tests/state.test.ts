import { describe, expect, it } from "vitest";

import {
  appendSource,
  createInitialParserState,
  finalizeState,
} from "../src/state.ts";

describe("createInitialParserState", () => {
  it("returns a mutable default state", () => {
    const state = createInitialParserState();

    expect(state).toMatchObject({
      version: 3,
      source: "",
      appendStartOffset: null,
      reparseFromOffset: 0,
      lineCache: [],
      lineCacheSourceLength: 0,
      lineCacheStartOffset: 0,
      finalized: false,
      pendingConstructs: [],
      blocks: [],
    });
    expect(state.referenceDefinitionIndex).toBeInstanceOf(Map);
    expect(state.referenceDefinitionIndex.size).toBe(0);
    expect(state.footnoteDefinitionIndex).toBeInstanceOf(Map);
    expect(state.footnoteDefinitionIndex.size).toBe(0);
  });
});

describe("appendSource", () => {
  it("tracks source growth and cursor movement across line breaks in place", () => {
    const initial = createInitialParserState();
    const first = appendSource(initial, "# Hi\n\n");
    const second = appendSource(first, "Mars");

    expect(first).toBe(initial);
    expect(second).toBe(first);
    expect(first).toMatchObject({
      source: "# Hi\n\nMars",
      appendStartOffset: 6,
      reparseFromOffset: 0,
    });
  });

  it("respects the parser-owned dirty offset when clean input is extended", () => {
    const state = createInitialParserState();

    state.source = "<script></script>";
    state.reparseFromOffset = 0;
    state.appendStartOffset = null;

    appendSource(state, "tail");

    expect(state).toMatchObject({
      source: "<script></script>tail",
      appendStartOffset: 17,
      reparseFromOffset: 0,
    });
  });

  it("refuses appends after finalization", () => {
    const finalized = finalizeState(createInitialParserState());

    expect(() => appendSource(finalized, "!")).toThrowError(
      "Cannot append source after finalization.",
    );
  });
});

describe("finalizeState", () => {
  it("is idempotent", () => {
    const initial = createInitialParserState();
    const first = finalizeState(initial);
    const second = finalizeState(first);

    expect(first.finalized).toBe(true);
    expect(second).toBe(first);
  });
});
