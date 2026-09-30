import type { InternalMarkdownState } from "./types";

function computeFinalizationDirtyOffset(state: InternalMarkdownState): number {
  let dirtyOffset = state.reparseFromOffset;

  for (const construct of state.pendingConstructs) {
    if (construct.startOffset < dirtyOffset) {
      dirtyOffset = construct.startOffset;
    }
  }

  return dirtyOffset;
}

export function createInitialParserState(): InternalMarkdownState {
  return {
    version: 3,
    source: "",
    appendedChunk: null,
    appendStartOffset: null,
    reparseFromOffset: 0,
    lineCache: [],
    lineCacheSourceLength: 0,
    lineCacheStartOffset: 0,
    finalized: false,
    pendingConstructs: [],
    blocks: [],
    referenceDefinitionIndex: new Map(),
    referenceDefinitions: [],
    footnoteDefinitionIndex: new Map(),
    footnoteDefinitions: [],
  };
}

export function appendSource(
  state: InternalMarkdownState,
  chunk: string,
  nextSource?: string,
): InternalMarkdownState {
  if (chunk.length === 0) {
    return state;
  }

  if (state.finalized && chunk.length > 0) {
    throw new Error("Cannot append source after finalization.");
  }

  state.appendStartOffset = state.source.length;
  state.appendedChunk = chunk;
  state.source = nextSource ?? state.source + chunk;

  return state;
}

export function finalizeState(
  state: InternalMarkdownState,
): InternalMarkdownState {
  if (state.finalized) {
    return state;
  }

  state.appendStartOffset = null;
  state.appendedChunk = null;
  state.reparseFromOffset = computeFinalizationDirtyOffset(state);
  state.finalized = true;
  return state;
}
