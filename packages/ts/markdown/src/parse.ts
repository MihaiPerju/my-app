import type {
  AlignType,
  BlockContent,
  Blockquote,
  Code,
  FootnoteDefinition,
  Heading,
  Html,
  List,
  ListItem,
  Math as MarkdownMath,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Table,
  TableCell,
  TableRow,
  ThematicBreak,
} from "mdast";

import {
  getClosedHtmlContinuationStartOffset,
  getCurrentLineStartOffset,
  getParagraphContinuationStartOffset,
  getPotentialContainerContinuationStartOffset,
  getTrailingParagraphContinuationStartOffset,
} from "./block-append";
import { decodeCharacterReferences } from "./character-reference";
import {
  isHtmlDeclarationStart,
  parseHtmlTagStart,
  scanCompleteClosingHtmlTag,
  scanCompleteOpeningHtmlTag,
} from "./html-scan";
import {
  DEFAULT_INLINE_PARSE_OPTIONS,
  createInlineCache,
  findReferenceDefinition,
  parseLinkReferenceDefinitions,
} from "./inline";
import type { InlineParseOptions } from "./inline";
import {
  applyMarkdownTransforms,
  createMarkdownTransformPlan,
} from "./post-process";
import { appendSource, createInitialParserState, finalizeState } from "./state";
import {
  decodeEscapablePunctuation,
  normalizeReferenceLabel,
} from "./text-normalize";
import type {
  InternalBlockQuoteBlockState,
  InternalBlockState,
  InternalCachedSourceLine,
  InternalCodeBlockState,
  InternalFootnoteReferenceDefinition,
  InternalFootnoteDefinitionBlockState,
  InternalHeadingBlockState,
  InternalHtmlBlockState,
  InternalInlineCache,
  InternalLinkReferenceDefinition,
  InternalListBlockState,
  InternalListItemState,
  InternalMathBlockState,
  InternalMarkdownResult,
  InternalMarkdownState,
  InternalParagraphBlockState,
  InternalRootBlockState,
  InternalSourceLine,
  InternalTableBlockState,
  InternalTableCellState,
  InternalTableRowState,
  InternalThematicBreakBlockState,
  MarkdownNodeFlags,
  MarkdownOptions,
  MarkdownSnapshot,
  PendingConstruct,
} from "./types";

const LAZY_CONTINUATION_SENTINEL = "\u0000";
const HTML_BLOCK_RAW_TAG_NAMES = new Set([
  "pre",
  "script",
  "style",
  "textarea",
]);
const HTML_BLOCK_TAG_NAMES = new Set([
  "address",
  "article",
  "aside",
  "base",
  "basefont",
  "blockquote",
  "body",
  "caption",
  "center",
  "col",
  "colgroup",
  "dd",
  "details",
  "dialog",
  "dir",
  "div",
  "dl",
  "dt",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "frame",
  "frameset",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "head",
  "header",
  "hr",
  "html",
  "iframe",
  "legend",
  "li",
  "link",
  "main",
  "menu",
  "menuitem",
  "nav",
  "noframes",
  "ol",
  "optgroup",
  "option",
  "p",
  "param",
  "search",
  "section",
  "summary",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "title",
  "tr",
  "track",
  "ul",
]);

type Line = InternalSourceLine;
type CachedLine = InternalCachedSourceLine;

type Fence = {
  readonly indent: number;
  readonly info: string;
  readonly length: number;
  readonly marker: "`" | "~";
};

type ListMarker = {
  readonly bullet?: "*" | "+" | "-";
  readonly content: string;
  readonly contentBlank: boolean;
  readonly contentIndent: number;
  readonly delimiter?: ")" | ".";
  readonly indent: number;
  readonly ordered: boolean;
  readonly start?: number;
};

type TaskListMarker = {
  readonly checked: boolean;
  readonly text: string;
};

type ParsedTableRow = {
  readonly cells: readonly string[];
  readonly hasSeparator: boolean;
};

type ParsedTail = {
  readonly lines: readonly Line[];
  readonly blocks: readonly InternalRootBlockState[];
  readonly definitions: readonly InternalLinkReferenceDefinition[];
  readonly footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[];
  readonly pendingConstructs: readonly PendingConstruct[];
  readonly blockContinuationStartOffset?: number;
};

type BlockContinuationTailContext = {
  readonly currentLineText: string;
  readonly lineStartOffset: number;
  readonly sourceLength: number;
};

type TrackedBlockContinuationOffsets = {
  paragraphStartOffset?: number;
  containerStartOffset?: number;
  htmlStartOffset?: number;
};

type NestedParseResult = {
  readonly blocks: readonly InternalBlockState[];
  readonly definitions: readonly InternalLinkReferenceDefinition[];
  readonly hasPendingConstructs: boolean;
};

type ParsedBlockResult = {
  readonly block: InternalRootBlockState;
  readonly definitions?: readonly InternalLinkReferenceDefinition[];
  readonly footnoteDefinitions?: readonly InternalFootnoteReferenceDefinition[];
  readonly nextIndex: number;
  readonly pendingConstruct: PendingConstruct | null;
};

type HtmlBlockKind =
  | {
      readonly kind: "blank-line";
      readonly canInterruptParagraph: boolean;
    }
  | {
      readonly kind: "closer";
      readonly closer: string;
      readonly canInterruptParagraph: true;
      readonly ignoreCase?: true;
    };

const EMPTY_LINES: readonly Line[] = [];
const EMPTY_CACHED_LINES: readonly CachedLine[] = [];
const EMPTY_DIAGNOSTICS: MarkdownSnapshot["diagnostics"] = [];
const OPEN_NODE_FLAGS = {
  unfinished: true,
  optimistic: true,
} as const satisfies MarkdownNodeFlags;
const OPEN_NODE_DATA = {
  mistralMarkdown: OPEN_NODE_FLAGS,
} as const;
const IS_HERMES_RUNTIME =
  typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !==
  "undefined";

function createEmptyRoot(children: RootContent[] = []): Root {
  return {
    type: "root",
    children,
  };
}

function isWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function isAsciiDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return code >= 0x30 && code <= 0x39;
}

function isSpaceOrTabOnly(text: string, startIndex = 0): boolean {
  for (let index = startIndex; index < text.length; index += 1) {
    if (!isWhitespace(text[index])) {
      return false;
    }
  }

  return true;
}

function findFirstSpaceOrTab(text: string, startIndex = 0): number {
  for (let index = startIndex; index < text.length; index += 1) {
    if (isWhitespace(text[index])) {
      return index;
    }
  }

  return -1;
}

function stripSpaceAndTabs(text: string): string {
  let normalized = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character !== " " && character !== "\t") {
      normalized += character;
    }
  }

  return normalized;
}

function isDashOnly(text: string): boolean {
  let dashCount = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character === " " || character === "\t") {
      continue;
    }

    if (character !== "-") {
      return false;
    }

    dashCount += 1;
  }

  return dashCount > 0;
}

function parseTableAlignmentMarker(text: string): AlignType | null {
  let index = 0;
  let startsWithColon = false;
  let endsWithColon = false;

  if (text[index] === ":") {
    startsWithColon = true;
    index += 1;
  }

  let dashCount = 0;

  while (text[index] === "-") {
    dashCount += 1;
    index += 1;
  }

  if (dashCount === 0) {
    return null;
  }

  if (text[index] === ":") {
    endsWithColon = true;
    index += 1;
  }

  if (index !== text.length) {
    return null;
  }

  if (startsWithColon && endsWithColon) {
    return "center";
  }

  if (startsWithColon) {
    return "left";
  }

  if (endsWithColon) {
    return "right";
  }

  return null;
}

function parseSetextUnderlineMarker(
  text: string,
  startIndex: number,
): 1 | 2 | null {
  const marker = text[startIndex];

  if (marker !== "=" && marker !== "-") {
    return null;
  }

  let index = startIndex;

  while (text[index] === marker) {
    index += 1;
  }

  if (!isSpaceOrTabOnly(text, index)) {
    return null;
  }

  return marker === "=" ? 1 : 2;
}

function withFlags<TNode extends { readonly type: string; data?: unknown }>(
  node: TNode,
  flags?: MarkdownNodeFlags,
): TNode {
  if (flags === undefined) {
    return node;
  }

  if (IS_HERMES_RUNTIME) {
    const mutableNode = node as TNode & { data?: unknown };

    if (flags === OPEN_NODE_FLAGS && node.data === undefined) {
      mutableNode.data = OPEN_NODE_DATA;
      return node;
    }

    const data = node.data as Record<string, unknown> | undefined;

    mutableNode.data =
      data === undefined
        ? {
            mistralMarkdown: flags,
          }
        : {
            ...data,
            mistralMarkdown: flags,
          };

    return node;
  }

  if (flags === OPEN_NODE_FLAGS && node.data === undefined) {
    return {
      ...node,
      data: OPEN_NODE_DATA,
    };
  }

  return {
    ...node,
    data: {
      ...((node.data as Record<string, unknown> | undefined) ?? {}),
      mistralMarkdown: flags,
    },
  } as TNode;
}

type Indent = {
  readonly columns: number;
  readonly index: number;
};

function advanceColumn(column: number, character: string): number {
  return character === "\t" ? column + (4 - (column % 4)) : column + 1;
}

function getLeadingIndent(text: string): Indent {
  let columns = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character !== " " && character !== "\t") {
      break;
    }

    columns = advanceColumn(columns, character);
    index += 1;
  }

  return {
    columns,
    index,
  };
}

function hasMoreThanThreeLeadingColumns(text: string): boolean {
  let columns = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character !== " " && character !== "\t") {
      return false;
    }

    columns = advanceColumn(columns, character);

    if (columns > 3) {
      return true;
    }

    index += 1;
  }

  return false;
}

function stripIndent(text: string, columns: number, startColumn = 0): string {
  let index = 0;
  let currentColumn = startColumn;
  let remaining = columns;

  while (index < text.length && remaining > 0) {
    const character = text[index] ?? "";

    if (character !== " " && character !== "\t") {
      break;
    }

    if (character === " ") {
      index += 1;
      currentColumn += 1;
      remaining -= 1;
      continue;
    }

    const nextColumn = advanceColumn(currentColumn, character);
    const width = nextColumn - currentColumn;
    index += 1;

    if (width > remaining) {
      return (
        " ".repeat(width - remaining) +
        normalizeLeadingIndent(text.slice(index), nextColumn)
      );
    }

    currentColumn = nextColumn;
    remaining -= width;
  }

  return normalizeLeadingIndent(text.slice(index), currentColumn);
}

function normalizeLeadingIndent(text: string, startColumn: number): string {
  let index = 0;
  let currentColumn = startColumn;
  let normalized = "";

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character !== " " && character !== "\t") {
      break;
    }

    if (character === " ") {
      normalized += " ";
      currentColumn += 1;
      index += 1;
      continue;
    }

    const nextColumn = advanceColumn(currentColumn, character);
    normalized += " ".repeat(nextColumn - currentColumn);
    currentColumn = nextColumn;
    index += 1;
  }

  return normalized + text.slice(index);
}

function countLeadingSpaces(text: string): number {
  return getLeadingIndent(text).columns;
}

function mayNeedInlineBracketReparse(text: string): boolean {
  return text.includes("[");
}

function createInlineBracketPendingConstruct(
  text: string,
  startOffset: number,
  finalized: boolean,
): PendingConstruct | null {
  if (finalized || !mayNeedInlineBracketReparse(text)) {
    return null;
  }

  return {
    kind: "inlineBracket",
    startOffset,
  };
}

function tableMayNeedInlineBracketReparse(
  header: InternalTableRowState,
  rows: readonly InternalTableRowState[],
): boolean {
  if (header.cells.some((cell) => mayNeedInlineBracketReparse(cell.text))) {
    return true;
  }

  return rows.some((row) =>
    row.cells.some((cell) => mayNeedInlineBracketReparse(cell.text)),
  );
}

function readLines(source: string, startOffset: number): Line[] {
  const lines: Line[] = [];
  let offset = startOffset;

  while (offset < source.length) {
    let endOffset = offset;

    while (endOffset < source.length) {
      const character = source[endOffset] ?? "";

      if (character === "\n" || character === "\r") {
        break;
      }

      endOffset += 1;
    }

    let nextOffset = endOffset;

    if (nextOffset < source.length) {
      const lineBreakCharacter = source[nextOffset] ?? "";
      nextOffset += 1;

      if (lineBreakCharacter === "\r" && (source[nextOffset] ?? "") === "\n") {
        nextOffset += 1;
      }
    }

    const line: Line = {
      startOffset: offset,
      endOffset,
      nextOffset,
      hasLineBreak: nextOffset > endOffset,
      text: source.slice(offset, endOffset),
    };

    lines.push(line);
    offset = line.nextOffset;
  }

  return lines;
}

function getLineBreakWidth(source: string, offset: number): 0 | 1 | 2 {
  const character = source[offset];

  if (character === "\n") {
    return 1;
  }

  if (character !== "\r") {
    return 0;
  }

  return source[offset + 1] === "\n" ? 2 : 1;
}

function findFirstLineBreakOffset(source: string, startOffset: number): number {
  for (let offset = startOffset; offset < source.length; offset += 1) {
    const character = source[offset];

    if (character === "\n" || character === "\r") {
      return offset;
    }
  }

  return -1;
}

function appendDirtyTailLines(
  source: string,
  lineCache: readonly Line[],
  appendStartOffset: number,
): readonly Line[] | undefined {
  const lastLine = lineCache.at(-1);

  if (lastLine === undefined || lastLine.nextOffset !== appendStartOffset) {
    return undefined;
  }

  if (lastLine.hasLineBreak) {
    if (
      appendStartOffset > 0 &&
      source[appendStartOffset - 1] === "\r" &&
      source[appendStartOffset] === "\n"
    ) {
      const updatedLastLine: Line = {
        ...lastLine,
        nextOffset: appendStartOffset + 1,
      };
      const appendedLines = readLines(source, updatedLastLine.nextOffset);
      const cachedPrefix = lineCache.slice(0, -1);

      if (cachedPrefix.length === 0) {
        return appendedLines.length === 0
          ? [updatedLastLine]
          : [updatedLastLine, ...appendedLines];
      }

      return appendedLines.length === 0
        ? [...cachedPrefix, updatedLastLine]
        : [...cachedPrefix, updatedLastLine, ...appendedLines];
    }

    const appendedLines = readLines(source, appendStartOffset);

    return appendedLines.length === 0
      ? lineCache
      : [...lineCache, ...appendedLines];
  }

  const cachedPrefix = lineCache.slice(0, -1);
  const firstLineBreakOffset = findFirstLineBreakOffset(
    source,
    appendStartOffset,
  );

  if (firstLineBreakOffset === -1) {
    const updatedLastLine: Line = {
      ...lastLine,
      endOffset: source.length,
      nextOffset: source.length,
      text: `${lastLine.text}${source.slice(appendStartOffset)}`,
    };

    return cachedPrefix.length === 0
      ? [updatedLastLine]
      : [...cachedPrefix, updatedLastLine];
  }

  const updatedLastLineNextOffset =
    firstLineBreakOffset + getLineBreakWidth(source, firstLineBreakOffset);
  const updatedLastLine: Line = {
    ...lastLine,
    endOffset: firstLineBreakOffset,
    hasLineBreak: true,
    nextOffset: updatedLastLineNextOffset,
    text: `${lastLine.text}${source.slice(appendStartOffset, firstLineBreakOffset)}`,
  };
  const appendedLines = readLines(source, updatedLastLine.nextOffset);

  if (cachedPrefix.length === 0) {
    return appendedLines.length === 0
      ? [updatedLastLine]
      : [updatedLastLine, ...appendedLines];
  }

  return appendedLines.length === 0
    ? [...cachedPrefix, updatedLastLine]
    : [...cachedPrefix, updatedLastLine, ...appendedLines];
}

function hydrateCachedLines(
  source: string,
  lineCache: readonly CachedLine[],
): readonly Line[] {
  if (lineCache.length === 0) {
    return EMPTY_LINES;
  }

  const hydratedLines = new Array<Line>(lineCache.length);

  for (let index = 0; index < lineCache.length; index += 1) {
    const line = lineCache[index];

    if (line === undefined) {
      continue;
    }

    hydratedLines[index] = {
      ...line,
      text: source.slice(line.startOffset, line.endOffset),
    };
  }

  return hydratedLines;
}

function dehydrateLines(lines: readonly Line[]): readonly CachedLine[] {
  if (lines.length === 0) {
    return EMPTY_CACHED_LINES;
  }

  const dehydratedLines = new Array<CachedLine>(lines.length);

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === undefined) {
      continue;
    }

    dehydratedLines[index] = {
      endOffset: line.endOffset,
      hasLineBreak: line.hasLineBreak,
      nextOffset: line.nextOffset,
      startOffset: line.startOffset,
    };
  }

  return dehydratedLines;
}

function getCachedDirtyTailLines(
  state: InternalMarkdownState,
  startOffset: number,
): readonly Line[] | undefined {
  if (state.lineCacheStartOffset !== startOffset) {
    return undefined;
  }

  if (state.lineCache.length === 0) {
    return startOffset === state.source.length ? [] : undefined;
  }

  if (state.appendStartOffset === null) {
    return state.lineCacheSourceLength === state.source.length
      ? hydrateCachedLines(state.source, state.lineCache)
      : undefined;
  }

  if (state.lineCacheSourceLength !== state.appendStartOffset) {
    return undefined;
  }

  return appendDirtyTailLines(
    state.source,
    hydrateCachedLines(state.source, state.lineCache),
    state.appendStartOffset,
  );
}

function getDirtyTailLines(
  state: InternalMarkdownState,
  startOffset: number,
): readonly Line[] {
  return (
    getCachedDirtyTailLines(state, startOffset) ??
    readLines(state.source, startOffset)
  );
}

function createRetainedLineCache(
  source: string,
  lines: readonly Line[],
  tailStartOffset: number,
  nextDirtyOffset: number,
): {
  readonly lines: readonly CachedLine[];
  readonly sourceLength: number;
  readonly startOffset: number;
} {
  if (nextDirtyOffset >= source.length) {
    return {
      lines: EMPTY_CACHED_LINES,
      sourceLength: source.length,
      startOffset: source.length,
    };
  }

  if (nextDirtyOffset === tailStartOffset) {
    return {
      lines: dehydrateLines(lines),
      sourceLength: source.length,
      startOffset: tailStartOffset,
    };
  }

  return {
    lines: dehydrateLines(readLines(source, nextDirtyOffset)),
    sourceLength: source.length,
    startOffset: nextDirtyOffset,
  };
}

function compactFinalizedState(state: InternalMarkdownState): void {
  if (!state.finalized) {
    return;
  }

  state.source = "";
  state.appendedChunk = null;
  state.appendStartOffset = null;
  state.reparseFromOffset = 0;
  state.lineCache = EMPTY_CACHED_LINES;
  state.lineCacheSourceLength = 0;
  state.lineCacheStartOffset = 0;
  state.pendingConstructs = [];
  state.blocks = [];
  state.referenceDefinitionIndex = new Map();
  state.referenceDefinitions = [];
  state.footnoteDefinitionIndex = new Map();
  state.footnoteDefinitions = [];
}

function buildLineSourceSlice(
  lines: readonly Line[],
  startIndex: number,
): {
  readonly localLineStarts: readonly number[];
  readonly source: string;
} {
  const localLineStarts: number[] = [];
  let source = "";

  for (let index = startIndex; index < lines.length; index += 1) {
    const line = lines[index];

    if (line === undefined) {
      continue;
    }

    localLineStarts.push(source.length);
    source += line.text;

    if (line.hasLineBreak) {
      source += "\n";
    }
  }

  return {
    localLineStarts,
    source,
  };
}

function getLocalLineSlot(
  localLineStarts: readonly number[],
  localOffset: number,
): number {
  let slot = 0;

  while (
    slot + 1 < localLineStarts.length &&
    (localLineStarts[slot + 1] ?? localOffset + 1) <= localOffset
  ) {
    slot += 1;
  }

  return slot;
}

function mapLocalOffsetToSourceOffset(
  lines: readonly Line[],
  startIndex: number,
  localLineStarts: readonly number[],
  localOffset: number,
): number {
  if (localLineStarts.length === 0) {
    return lines[startIndex]?.startOffset ?? 0;
  }

  const slot = getLocalLineSlot(localLineStarts, localOffset);
  const line = lines[startIndex + slot];
  const localLineStart = localLineStarts[slot] ?? 0;

  if (line === undefined) {
    return lines[startIndex]?.startOffset ?? 0;
  }

  return line.startOffset + (localOffset - localLineStart);
}

function countConsumedLines(
  localLineStarts: readonly number[],
  nextOffset: number,
): number {
  if (nextOffset <= 0 || localLineStarts.length === 0) {
    return 0;
  }

  return getLocalLineSlot(localLineStarts, nextOffset - 1) + 1;
}

function isBlankLine(text: string): boolean {
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];

    if (character !== " " && character !== "\t") {
      return false;
    }
  }

  return true;
}

function canStillBecomeBlockStart(text: string): boolean {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return false;
  }

  const character = text[indent.index];

  if (character === undefined) {
    return true;
  }

  return (
    character === "#" ||
    character === "`" ||
    character === "~" ||
    character === "<" ||
    character === ">" ||
    character === "[" ||
    character === "!" ||
    character === "|" ||
    character === ":" ||
    character === "-" ||
    character === "+" ||
    character === "*" ||
    character === "_" ||
    character === "=" ||
    character === "$" ||
    character === "\\" ||
    isAsciiDigit(character)
  );
}

function parseAtxHeading(line: Line): {
  readonly depth: 1 | 2 | 3 | 4 | 5 | 6;
  readonly text: string;
} | null {
  const text = line.text;
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return null;
  }

  let index = indent.index;

  while ((text[index] ?? "") === "#") {
    index += 1;
  }

  const markerCount = index - indent.index;

  if (markerCount < 1 || markerCount > 6) {
    return null;
  }

  const nextCharacter = text[index];

  if (nextCharacter !== undefined && !isWhitespace(nextCharacter)) {
    return null;
  }

  while (isWhitespace(text[index])) {
    index += 1;
  }

  let contentEnd = text.length;

  while (contentEnd > index && isWhitespace(text[contentEnd - 1])) {
    contentEnd -= 1;
  }

  if (contentEnd <= index) {
    return {
      depth: markerCount as 1 | 2 | 3 | 4 | 5 | 6,
      text: "",
    };
  }

  let closingStart = contentEnd;

  while (closingStart > index && text[closingStart - 1] === "#") {
    closingStart -= 1;
  }

  if (closingStart === index) {
    contentEnd = index;
  } else if (
    closingStart < contentEnd &&
    isWhitespace(text[closingStart - 1])
  ) {
    contentEnd = closingStart - 1;

    while (contentEnd > index && isWhitespace(text[contentEnd - 1])) {
      contentEnd -= 1;
    }
  }

  return {
    depth: markerCount as 1 | 2 | 3 | 4 | 5 | 6,
    text: text.slice(index, contentEnd),
  };
}

function parseSetextUnderline(text: string): 1 | 2 | null {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return null;
  }

  return parseSetextUnderlineMarker(text, indent.index);
}

function isThematicBreak(text: string): boolean {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return false;
  }

  let marker: "*" | "-" | "_" | null = null;
  let markerCount = 0;

  for (const character of text.slice(indent.index)) {
    if (character === " " || character === "\t") {
      continue;
    }

    if (character !== "*" && character !== "-" && character !== "_") {
      return false;
    }

    if (marker === null) {
      marker = character;
    }

    if (character !== marker) {
      return false;
    }

    markerCount += 1;
  }

  return markerCount >= 3;
}

function parseFence(line: Line): Fence | null {
  const indent = getLeadingIndent(line.text);

  if (indent.columns > 3) {
    return null;
  }

  const marker = line.text[indent.index];

  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let index = indent.index;

  while ((line.text[index] ?? "") === marker) {
    index += 1;
  }

  const length = index - indent.index;

  if (length < 3) {
    return null;
  }

  const info = line.text.slice(index);

  if (marker === "`" && info.includes("`")) {
    return null;
  }

  return {
    indent: indent.columns,
    info: info.trim(),
    length,
    marker,
  };
}

function isFenceCloser(line: Line, fence: Fence): boolean {
  const indent = getLeadingIndent(line.text);

  if (indent.columns > 3) {
    return false;
  }

  let index = indent.index;

  while ((line.text[index] ?? "") === fence.marker) {
    index += 1;
  }

  if (index - indent.index < fence.length) {
    return false;
  }

  return isSpaceOrTabOnly(line.text, index);
}

function parseMathFence(
  line: Line,
  mathExtensions: boolean,
): {
  readonly closer: "$$" | "\\]";
  readonly initialValue?: string;
  readonly meta?: string;
  readonly singleLineValue?: string;
} | null {
  if (!mathExtensions) {
    return null;
  }

  const indent = getLeadingIndent(line.text);

  if (indent.columns > 3) {
    return null;
  }

  if (line.text.startsWith("$$", indent.index)) {
    const afterOpener = line.text.slice(indent.index + 2);

    if ((afterOpener[0] ?? "") === "$") {
      return null;
    }

    const sameLineCloserIndex = afterOpener.indexOf("$$");

    if (
      sameLineCloserIndex > 0 &&
      isSpaceOrTabOnly(afterOpener, sameLineCloserIndex + 2)
    ) {
      return {
        closer: "$$",
        singleLineValue: afterOpener.slice(0, sameLineCloserIndex),
      };
    }

    const meta = afterOpener.trim();

    return meta.length === 0 ? { closer: "$$" } : { closer: "$$", meta };
  }

  if (!line.text.startsWith("\\[", indent.index)) {
    return null;
  }

  const afterOpener = line.text.slice(indent.index + 2);
  const sameLineCloserIndex = afterOpener.indexOf("\\]");

  if (
    sameLineCloserIndex >= 0 &&
    isSpaceOrTabOnly(afterOpener, sameLineCloserIndex + 2)
  ) {
    return {
      closer: "\\]",
      singleLineValue: afterOpener.slice(0, sameLineCloserIndex),
    };
  }

  const initialValue = afterOpener.trimStart();

  return initialValue.length === 0
    ? { closer: "\\]" }
    : {
        closer: "\\]",
        initialValue,
      };
}

function isMathFenceCloser(line: Line, closer: "$$" | "\\]"): boolean {
  const indent = getLeadingIndent(line.text);

  if (!line.text.startsWith(closer, indent.index)) {
    return false;
  }

  if (closer === "$$" && (line.text[indent.index + 2] ?? "") === "$") {
    return false;
  }

  return isSpaceOrTabOnly(line.text, indent.index + closer.length);
}

function parseFenceInfo(info: string): {
  readonly lang?: string;
  readonly meta?: string;
} {
  if (info.length === 0) {
    return {};
  }

  const splitIndex = findFirstSpaceOrTab(info);

  if (splitIndex === -1) {
    return {
      lang: decodeCharacterReferences(decodeEscapablePunctuation(info)),
    };
  }

  const lang = decodeCharacterReferences(
    decodeEscapablePunctuation(info.slice(0, splitIndex)),
  );
  const meta = decodeCharacterReferences(
    decodeEscapablePunctuation(info.slice(splitIndex).trim()),
  );

  return meta.length === 0
    ? { lang }
    : {
        lang,
        meta,
      };
}

function stripFenceIndent(text: string, indent: number): string {
  return stripIndent(text, indent);
}

function parseBlockQuoteContent(text: string): string | null {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3 || text[indent.index] !== ">") {
    return null;
  }

  let content = text.slice(indent.index + 1);

  if (content.startsWith(" ") || content.startsWith("\t")) {
    content = stripIndent(content, 1, indent.columns + 1);
  }

  return normalizeLeadingIndent(content, indent.columns + 2);
}

function isCompleteHtmlTagLine(text: string): boolean {
  const endIndex = text.startsWith("</")
    ? scanCompleteClosingHtmlTag(text)
    : scanCompleteOpeningHtmlTag(text);

  return endIndex !== null && isSpaceOrTabOnly(text, endIndex);
}

function getHtmlBlockKind(line: Line): HtmlBlockKind | null {
  const indent = getLeadingIndent(line.text);

  if (indent.columns > 3) {
    return null;
  }

  if (line.text[indent.index] !== "<") {
    return null;
  }

  const candidate = line.text.slice(indent.index);

  if (candidate.startsWith("<!--")) {
    return {
      kind: "closer",
      closer: "-->",
      canInterruptParagraph: true,
    };
  }

  if (candidate.startsWith("<?")) {
    return {
      kind: "closer",
      closer: "?>",
      canInterruptParagraph: true,
    };
  }

  if (candidate.startsWith("<![CDATA[")) {
    return {
      kind: "closer",
      closer: "]]>",
      canInterruptParagraph: true,
    };
  }

  if (isHtmlDeclarationStart(candidate)) {
    return {
      kind: "closer",
      closer: ">",
      canInterruptParagraph: true,
    };
  }

  const tag = parseHtmlTagStart(candidate);

  if (tag === null) {
    return null;
  }

  if (!tag.closing && HTML_BLOCK_RAW_TAG_NAMES.has(tag.name)) {
    return {
      kind: "closer",
      closer: `</${tag.name}>`,
      canInterruptParagraph: true,
      ignoreCase: true,
    };
  }

  if (HTML_BLOCK_TAG_NAMES.has(tag.name)) {
    return {
      kind: "blank-line",
      canInterruptParagraph: true,
    };
  }

  if (!isCompleteHtmlTagLine(candidate)) {
    return null;
  }

  return {
    kind: "blank-line",
    canInterruptParagraph: false,
  };
}

function canInterruptParagraphWithHtmlBlock(line: Line): boolean {
  return getHtmlBlockKind(line)?.canInterruptParagraph === true;
}

function parseListMarker(line: Line): ListMarker | null {
  const indent = getLeadingIndent(line.text);

  if (indent.columns > 3) {
    return null;
  }

  const marker = line.text[indent.index];

  if (
    (marker === "-" || marker === "+" || marker === "*") &&
    (line.text.length === indent.index + 1 ||
      isWhitespace(line.text[indent.index + 1]))
  ) {
    const markerEnd = indent.index + 1;
    let contentIndex = markerEnd;
    let contentColumn = indent.columns + 1;

    while (isWhitespace(line.text[contentIndex])) {
      contentColumn = advanceColumn(
        contentColumn,
        line.text[contentIndex] ?? "",
      );
      contentIndex += 1;
    }

    const contentBlank = contentIndex >= line.text.length;
    const spacesAfterMarker = contentColumn - (indent.columns + 1);
    const effectiveContentIndex =
      contentBlank || spacesAfterMarker > 4
        ? stripIndent(line.text.slice(markerEnd), 1, indent.columns + 1)
        : line.text.slice(contentIndex);

    return {
      bullet: marker,
      content: contentBlank
        ? ""
        : normalizeLeadingIndent(
            effectiveContentIndex,
            contentBlank || spacesAfterMarker > 4
              ? indent.columns + 2
              : indent.columns + 1 + spacesAfterMarker,
          ),
      contentBlank,
      contentIndent:
        contentBlank || spacesAfterMarker > 4
          ? indent.columns + 2
          : indent.columns + 1 + spacesAfterMarker,
      indent: indent.columns,
      ordered: false,
    };
  }

  let index = indent.index;

  while (isAsciiDigit(line.text[index])) {
    index += 1;
  }

  if (index === indent.index || index - indent.index > 9) {
    return null;
  }

  const delimiter = line.text[index];

  if (
    (delimiter !== "." && delimiter !== ")") ||
    (line.text.length > index + 1 && !isWhitespace(line.text[index + 1]))
  ) {
    return null;
  }

  const markerEnd = index + 1;
  let contentIndex = markerEnd;
  let contentColumn = indent.columns + (markerEnd - indent.index);

  while (isWhitespace(line.text[contentIndex])) {
    contentColumn = advanceColumn(contentColumn, line.text[contentIndex] ?? "");
    contentIndex += 1;
  }

  const contentBlank = contentIndex >= line.text.length;
  const spacesAfterMarker =
    contentColumn - (indent.columns + (markerEnd - indent.index));

  return {
    content: contentBlank
      ? ""
      : normalizeLeadingIndent(
          spacesAfterMarker > 4
            ? stripIndent(
                line.text.slice(markerEnd),
                1,
                indent.columns + (markerEnd - indent.index),
              )
            : line.text.slice(contentIndex),
          contentBlank || spacesAfterMarker > 4
            ? indent.columns + (markerEnd - indent.index) + 1
            : indent.columns + (markerEnd - indent.index) + spacesAfterMarker,
        ),
    contentBlank,
    contentIndent:
      contentBlank || spacesAfterMarker > 4
        ? indent.columns + (markerEnd - indent.index) + 1
        : indent.columns + (markerEnd - indent.index) + spacesAfterMarker,
    delimiter,
    indent: indent.columns,
    ordered: true,
    start: Number.parseInt(line.text.slice(indent.index, index), 10),
  };
}

function parseTaskListMarker(text: string): TaskListMarker | null {
  if (!text.startsWith("[") || text[2] !== "]") {
    return null;
  }

  const marker = text[1];

  if (marker !== " " && marker !== "x" && marker !== "X") {
    return null;
  }

  const boundary = text[3];

  if (boundary !== undefined && boundary !== " " && boundary !== "\t") {
    return null;
  }

  return {
    checked: marker !== " ",
    text: boundary === undefined ? "" : text.slice(4),
  };
}

function skipTableCodeSpan(text: string, startIndex: number): number | null {
  if (text[startIndex] !== "`") {
    return null;
  }

  let openerEnd = startIndex;

  while (text[openerEnd] === "`") {
    openerEnd += 1;
  }

  const openerLength = openerEnd - startIndex;
  let searchIndex = openerEnd;

  while (searchIndex < text.length) {
    if (text[searchIndex] !== "`") {
      searchIndex += 1;
      continue;
    }

    let closerEnd = searchIndex;

    while (text[closerEnd] === "`") {
      closerEnd += 1;
    }

    if (closerEnd - searchIndex === openerLength) {
      return closerEnd;
    }

    searchIndex = closerEnd;
  }

  return null;
}

function splitTableRow(text: string): ParsedTableRow | null {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return null;
  }

  const candidate = text.slice(indent.index);

  if (candidate.length === 0) {
    return null;
  }

  const cells: string[] = [];
  let buffer = "";
  let hasSeparator = false;
  let index = 0;

  while (index < candidate.length) {
    const character = candidate[index] ?? "";

    if (character === "\\") {
      const escapedCharacter = candidate[index + 1];

      if (escapedCharacter !== undefined) {
        buffer += escapedCharacter === "|" ? "|" : `\\${escapedCharacter}`;
        index += 2;
        continue;
      }

      buffer += character;
      index += 1;
      continue;
    }

    if (character === "`") {
      const codeSpanEnd = skipTableCodeSpan(candidate, index);

      if (codeSpanEnd !== null) {
        buffer += candidate.slice(index, codeSpanEnd);
        index = codeSpanEnd;
        continue;
      }
    }

    if (character === "|") {
      cells.push(buffer.trim());
      buffer = "";
      hasSeparator = true;
      index += 1;
      continue;
    }

    buffer += character;
    index += 1;
  }

  cells.push(buffer.trim());

  const trimmedCandidate = candidate.trim();

  if (trimmedCandidate.startsWith("|")) {
    cells.shift();
  }

  if (trimmedCandidate.endsWith("|")) {
    cells.pop();
  }

  return {
    cells,
    hasSeparator,
  };
}

function parseTableAlignment(text: string): AlignType | null {
  return parseTableAlignmentMarker(stripSpaceAndTabs(text));
}

function parseTableDelimiterRow(text: string): readonly AlignType[] | null {
  const row = splitTableRow(text);

  if (row === null || !row.hasSeparator || row.cells.length === 0) {
    return null;
  }

  const align: AlignType[] = [];

  for (const cell of row.cells) {
    const alignment = parseTableAlignment(cell);

    if (alignment === null && !isDashOnly(cell)) {
      return null;
    }

    align.push(alignment);
  }

  return align;
}

function normalizeTableCells(
  cells: readonly string[],
  columnCount: number,
): string[] {
  if (cells.length === columnCount) {
    return [...cells];
  }

  if (cells.length > columnCount) {
    return cells.slice(0, columnCount);
  }

  const normalized = [...cells];

  while (normalized.length < columnCount) {
    normalized.push("");
  }

  return normalized;
}

function canStartTable(
  lines: readonly Line[],
  startIndex: number,
  gfmExtensions: boolean,
): boolean {
  if (!gfmExtensions) {
    return false;
  }

  const headerLine = lines[startIndex];
  const delimiterLine = lines[startIndex + 1];

  if (headerLine === undefined || delimiterLine === undefined) {
    return false;
  }

  if (!headerLine.text.includes("|") || !delimiterLine.text.includes("|")) {
    return false;
  }

  const header = splitTableRow(headerLine.text);
  const align = parseTableDelimiterRow(delimiterLine.text);

  return (
    header !== null &&
    header.hasSeparator &&
    header.cells.length > 0 &&
    align !== null &&
    header.cells.length === align.length
  );
}

function createTableRowState(
  cells: readonly string[],
  previousRow?: InternalTableRowState,
): InternalTableRowState {
  const nextCells = cells.map((text, index) => {
    const normalizedText = text.replaceAll("\\|", "|");
    const previousCell = previousRow?.cells[index];

    return previousCell?.text === normalizedText
      ? previousCell
      : ({
          text: normalizedText,
        } satisfies InternalTableCellState);
  });
  const stableCells =
    previousRow === undefined
      ? nextCells
      : reuseArrayIfEntriesEqual(previousRow.cells, nextCells);

  return previousRow !== undefined && previousRow.cells === stableCells
    ? previousRow
    : {
        cells: stableCells,
      };
}

function areTableAlignmentsEqual(
  previousAlign: readonly AlignType[] | undefined,
  nextAlign: readonly AlignType[],
): boolean {
  if (
    previousAlign === undefined ||
    previousAlign.length !== nextAlign.length
  ) {
    return false;
  }

  for (let index = 0; index < nextAlign.length; index += 1) {
    if (previousAlign[index] !== nextAlign[index]) {
      return false;
    }
  }

  return true;
}

function isIndentedCodeLine(text: string): boolean {
  return !isBlankLine(text) && countLeadingSpaces(text) >= 4;
}

function canOnlyStartParagraphLine(line: Line): boolean {
  const firstCharacter = line.text[0];

  if (firstCharacter !== " " && firstCharacter !== "\t") {
    return (
      firstCharacter !== undefined &&
      firstCharacter !== "[" &&
      firstCharacter !== ">" &&
      !(firstCharacter === "$" && (line.text[1] ?? "") === "$") &&
      !(firstCharacter === "\\" && (line.text[1] ?? "") === "[") &&
      firstCharacter !== "`" &&
      firstCharacter !== "~" &&
      firstCharacter !== "#" &&
      firstCharacter !== "*" &&
      firstCharacter !== "-" &&
      firstCharacter !== "_" &&
      firstCharacter !== "+" &&
      firstCharacter !== "<" &&
      !isAsciiDigit(firstCharacter)
    );
  }

  const indent = getLeadingIndent(line.text);

  if (indent.columns > 3) {
    return false;
  }

  const indentedFirstCharacter = line.text[indent.index];

  return (
    indentedFirstCharacter !== undefined &&
    indentedFirstCharacter !== "[" &&
    indentedFirstCharacter !== ">" &&
    !(
      indentedFirstCharacter === "$" &&
      (line.text[indent.index + 1] ?? "") === "$"
    ) &&
    !(
      indentedFirstCharacter === "\\" &&
      (line.text[indent.index + 1] ?? "") === "["
    ) &&
    indentedFirstCharacter !== "`" &&
    indentedFirstCharacter !== "~" &&
    indentedFirstCharacter !== "#" &&
    indentedFirstCharacter !== "*" &&
    indentedFirstCharacter !== "-" &&
    indentedFirstCharacter !== "_" &&
    indentedFirstCharacter !== "+" &&
    indentedFirstCharacter !== "<" &&
    !isAsciiDigit(indentedFirstCharacter)
  );
}

function canInterruptParagraphWithListMarker(line: Line): boolean {
  const marker = parseListMarker(line);

  if (marker === null) {
    return false;
  }

  if (marker.content.length === 0) {
    return false;
  }

  return !marker.ordered || marker.start === 1;
}

function isParagraphTerminator(
  lines: readonly Line[],
  lineIndex: number,
  inlineOptions: InlineParseOptions,
): boolean {
  const line = lines[lineIndex];

  if (line === undefined) {
    return false;
  }

  if (hasMoreThanThreeLeadingColumns(line.text)) {
    return false;
  }

  if (parseBlockQuoteContent(line.text) !== null) {
    return true;
  }

  if (canInterruptParagraphWithHtmlBlock(line)) {
    return true;
  }

  if (parseFence(line) !== null) {
    return true;
  }

  if (parseMathFence(line, inlineOptions.mathExtensions) !== null) {
    return true;
  }

  if (parseAtxHeading(line) !== null) {
    return true;
  }

  if (isThematicBreak(line.text)) {
    return true;
  }

  if (canInterruptParagraphWithListMarker(line)) {
    return true;
  }

  return canStartTable(lines, lineIndex, inlineOptions.gfmExtensions);
}

function isLazyContinuationLine(
  lines: readonly Line[],
  lineIndex: number,
  inlineOptions: InlineParseOptions,
): boolean {
  const line = lines[lineIndex];

  if (line === undefined) {
    return false;
  }

  return (
    parseBlockQuoteContent(line.text) === null &&
    !isBlankLine(line.text) &&
    !isParagraphTerminator(lines, lineIndex, inlineOptions)
  );
}

function areReferenceDefinitionsEqual(
  previousDefinitions: readonly InternalLinkReferenceDefinition[] | undefined,
  nextDefinitions: readonly InternalLinkReferenceDefinition[],
): boolean {
  if (previousDefinitions === undefined) {
    return false;
  }

  if (previousDefinitions.length !== nextDefinitions.length) {
    return false;
  }

  for (let index = 0; index < nextDefinitions.length; index += 1) {
    const previousDefinition = previousDefinitions[index];
    const nextDefinition = nextDefinitions[index];

    if (
      previousDefinition?.normalizedLabel !== nextDefinition?.normalizedLabel ||
      previousDefinition?.title !== nextDefinition?.title ||
      previousDefinition?.url !== nextDefinition?.url
    ) {
      return false;
    }
  }

  return true;
}

function areFootnoteDefinitionsEqual(
  previousDefinitions:
    | readonly InternalFootnoteReferenceDefinition[]
    | undefined,
  nextDefinitions: readonly InternalFootnoteReferenceDefinition[],
): boolean {
  if (previousDefinitions === undefined) {
    return false;
  }

  if (previousDefinitions.length !== nextDefinitions.length) {
    return false;
  }

  for (let index = 0; index < nextDefinitions.length; index += 1) {
    const previousDefinition = previousDefinitions[index];
    const nextDefinition = nextDefinitions[index];

    if (
      previousDefinition?.normalizedLabel !== nextDefinition?.normalizedLabel ||
      previousDefinition?.block !== nextDefinition?.block
    ) {
      return false;
    }
  }

  return true;
}

function canStartReferenceDefinition(line: Line): boolean {
  const indent = getLeadingIndent(line.text);

  return indent.columns <= 3 && line.text[indent.index] === "[";
}

function canStartFootnoteDefinition(line: Line): boolean {
  const indent = getLeadingIndent(line.text);

  return (
    indent.columns <= 3 &&
    line.text[indent.index] === "[" &&
    line.text[indent.index + 1] === "^"
  );
}

function parseLinkReferenceDefinitionsFromLines(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
): {
  readonly definitions: readonly InternalLinkReferenceDefinition[];
  readonly nextIndex: number;
  readonly pendingConstruct: PendingConstruct | null;
} | null {
  const { localLineStarts, source } = buildLineSourceSlice(lines, startIndex);
  const parsed = parseLinkReferenceDefinitions(source, 0);

  if (parsed === null) {
    return null;
  }

  const consumedLineCount = countConsumedLines(
    localLineStarts,
    parsed.nextOffset,
  );
  const nextIndex = startIndex + consumedLineCount;
  const nextLine = lines[nextIndex];
  const lastConsumedLine =
    consumedLineCount === 0 ? undefined : lines[nextIndex - 1];
  const trailingDefinition = parsed.definitions.at(-1);

  return {
    definitions: parsed.definitions.map((definition) => ({
      ...definition,
      startOffset: mapLocalOffsetToSourceOffset(
        lines,
        startIndex,
        localLineStarts,
        definition.startOffset,
      ),
    })),
    nextIndex,
    pendingConstruct:
      !finalized &&
      trailingDefinition !== undefined &&
      (lastConsumedLine?.hasLineBreak === false ||
        nextLine === undefined ||
        !nextLine.hasLineBreak)
        ? {
            kind: "referenceDefinition",
            startOffset: mapLocalOffsetToSourceOffset(
              lines,
              startIndex,
              localLineStarts,
              trailingDefinition.startOffset,
            ),
          }
        : null,
  };
}

function parseFootnoteDefinitionStart(line: Line): {
  readonly identifier: string;
  readonly label: string;
  readonly text: string;
} | null {
  const indent = getLeadingIndent(line.text);

  if (
    indent.columns > 3 ||
    line.text[indent.index] !== "[" ||
    line.text[indent.index + 1] !== "^"
  ) {
    return null;
  }

  let labelEndIndex = indent.index + 2;

  while (labelEndIndex < line.text.length) {
    const character = line.text[labelEndIndex] ?? "";

    if (character === "\\") {
      if (line.text[labelEndIndex + 1] === undefined) {
        return null;
      }

      labelEndIndex += 2;
      continue;
    }

    if (character === "]") {
      break;
    }

    if (character === "[" || character === "\n" || character === "\r") {
      return null;
    }

    labelEndIndex += 1;
  }

  if (
    line.text[labelEndIndex] !== "]" ||
    line.text[labelEndIndex + 1] !== ":"
  ) {
    return null;
  }

  const rawLabel = line.text.slice(indent.index + 2, labelEndIndex);
  const identifier = normalizeReferenceLabel(rawLabel);

  if (identifier.length === 0) {
    return null;
  }

  return {
    identifier,
    label: decodeCharacterReferences(decodeEscapablePunctuation(rawLabel)),
    text: line.text.slice(labelEndIndex + 2).trimStart(),
  };
}

function parseFootnoteDefinition(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  previousBlock?: InternalRootBlockState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): ParsedBlockResult | null {
  const startLine = lines[startIndex];

  if (startLine === undefined) {
    return null;
  }

  const parsedStart = parseFootnoteDefinitionStart(startLine);

  if (parsedStart === null) {
    return null;
  }

  const previousFootnoteBlock =
    previousBlock?.kind === "footnoteDefinition" ? previousBlock : undefined;
  const nestedLines: Line[] =
    parsedStart.text.length === 0
      ? []
      : [
          {
            ...startLine,
            text: parsedStart.text,
          },
        ];
  let nextIndex = startIndex + 1;
  let open = !startLine.hasLineBreak && !finalized;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined) {
      break;
    }

    if (isBlankLine(line.text)) {
      nestedLines.push({
        ...line,
        text: "",
      });
      nextIndex += 1;
      continue;
    }

    if (countLeadingSpaces(line.text) < 4) {
      break;
    }

    nestedLines.push({
      ...line,
      text: stripIndent(line.text, 4),
    });
    nextIndex += 1;
  }

  if (nextIndex >= lines.length && !finalized) {
    open = true;
  }

  const nested = parseNestedBlocks(
    nestedLines,
    !open,
    previousFootnoteBlock?.children,
    inlineOptions,
  );
  open = open || nested.hasPendingConstructs;
  const endLine = lines[nextIndex - 1] ?? startLine;
  const footnoteBlock: InternalFootnoteDefinitionBlockState = {
    kind: "footnoteDefinition",
    startOffset: startLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    identifier: parsedStart.identifier,
    label: parsedStart.label,
    children: nested.blocks,
  };
  const block =
    previousFootnoteBlock !== undefined &&
    hasSameBlockBase(footnoteBlock, previousFootnoteBlock) &&
    footnoteBlock.identifier === previousFootnoteBlock.identifier &&
    footnoteBlock.label === previousFootnoteBlock.label &&
    footnoteBlock.children === previousFootnoteBlock.children
      ? previousFootnoteBlock
      : footnoteBlock;

  return {
    block,
    definitions: nested.definitions,
    footnoteDefinitions: [
      {
        normalizedLabel: parsedStart.identifier,
        label: parsedStart.label,
        startOffset: startLine.startOffset,
        block,
      },
    ],
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "footnoteDefinition",
          startOffset: startLine.startOffset,
        }
      : null,
  };
}

function reuseArrayIfEntriesEqual<T>(
  previous: readonly T[] | undefined,
  next: T[],
): T[] {
  if (previous === undefined || previous.length !== next.length) {
    return next;
  }

  for (let index = 0; index < next.length; index += 1) {
    if (previous[index] !== next[index]) {
      return next;
    }
  }

  return previous as T[];
}

function hasBlankLineBetweenOffsets(
  lines: readonly Line[],
  startOffset: number,
  endOffset: number,
): boolean {
  for (const line of lines) {
    if (line.startOffset < startOffset) {
      continue;
    }

    if (line.startOffset >= endOffset) {
      return false;
    }

    if (isBlankLine(line.text)) {
      return true;
    }
  }

  return false;
}

function hasSameBlockBase(
  nextBlock: {
    readonly endOffset: number;
    readonly open: boolean;
    readonly startOffset: number;
  },
  previousBlock: {
    readonly endOffset: number;
    readonly open: boolean;
    readonly startOffset: number;
  },
): boolean {
  return (
    nextBlock.startOffset === previousBlock.startOffset &&
    nextBlock.endOffset === previousBlock.endOffset &&
    nextBlock.open === previousBlock.open
  );
}

function hasSameListItemIdentity(
  nextItem: InternalListItemState,
  previousItem: InternalListItemState,
): boolean {
  return hasSameBlockBase(nextItem, previousItem);
}

function computeListItemSpread(
  lines: readonly Line[],
  children: readonly InternalBlockState[],
): boolean {
  for (let index = 1; index < children.length; index += 1) {
    const previousChild = children[index - 1];
    const child = children[index];

    if (previousChild === undefined || child === undefined) {
      continue;
    }

    if (
      hasBlankLineBetweenOffsets(
        lines,
        previousChild.endOffset,
        child.startOffset,
      )
    ) {
      return true;
    }
  }

  return false;
}

function hasTrailingSeparatedContent(
  lines: readonly Line[],
  children: readonly InternalBlockState[],
): boolean {
  const lastChild = children.at(-1);

  if (lastChild === undefined) {
    return false;
  }

  let sawBlankLine = false;

  for (const line of lines) {
    if (line.startOffset < lastChild.endOffset) {
      continue;
    }

    if (isBlankLine(line.text)) {
      sawBlankLine = true;
      continue;
    }

    if (sawBlankLine) {
      return true;
    }
  }

  return false;
}

function computeListSpread(
  lines: readonly Line[],
  items: readonly InternalListItemState[],
): boolean {
  for (const item of items) {
    if (item.spread || item.hasTrailingSeparatedContent) {
      return true;
    }
  }

  for (let index = 1; index < items.length; index += 1) {
    const previousItem = items[index - 1];
    const item = items[index];

    if (previousItem === undefined || item === undefined) {
      continue;
    }

    if (
      hasBlankLineBetweenOffsets(
        lines,
        previousItem.endOffset,
        item.startOffset,
      )
    ) {
      return true;
    }
  }

  return false;
}

function createProjectedRoot(
  children: RootContent[],
  reusePreviousRoot: boolean,
  previousRoot?: Root,
): Root {
  if (reusePreviousRoot && previousRoot !== undefined) {
    return previousRoot;
  }

  return createEmptyRoot(children);
}

function isBlockContentNode(value: unknown): value is BlockContent {
  if (typeof value !== "object" || value === null || !("type" in value)) {
    return false;
  }

  switch (value.type) {
    case "blockquote":
    case "code":
    case "heading":
    case "html":
    case "list":
    case "paragraph":
    case "table":
    case "thematicBreak":
      return true;
    default:
      return false;
  }
}

function isRootContentNode(value: unknown): value is RootContent {
  if (isBlockContentNode(value)) {
    return true;
  }

  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    value.type === "footnoteDefinition"
  );
}

function getPreviousBlockContent(
  children: readonly unknown[] | undefined,
  index: number,
): BlockContent | undefined {
  const previousChild = children?.[index];

  return isBlockContentNode(previousChild) ? previousChild : undefined;
}

function getPreviousRootContent(
  children: readonly unknown[] | undefined,
  index: number,
): RootContent | undefined {
  const previousChild = children?.[index];

  return isRootContentNode(previousChild) ? previousChild : undefined;
}

function getOpenFlags(open: boolean): MarkdownNodeFlags | undefined {
  return open ? OPEN_NODE_FLAGS : undefined;
}

function getPreferredInlineChildren(
  inlineCache: InternalInlineCache,
  open: boolean,
): PhrasingContent[] {
  return open
    ? (inlineCache.optimisticChildren ?? inlineCache.children)
    : inlineCache.children;
}

function isAmbiguousStandaloneOpenParagraphText(text: string): boolean {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return false;
  }

  let candidate = "";

  for (let index = indent.index; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === " " || character === "\t") {
      continue;
    }

    candidate += character;

    if (candidate.length > 10) {
      return false;
    }
  }

  if (candidate.length === 0) {
    return false;
  }

  if (isAmbiguousOrderedListMarkerCandidate(candidate)) {
    return true;
  }

  if (candidate === "-" || candidate === "+" || candidate === "*") {
    return true;
  }

  return isShortRepeatedAmbiguousMarkerRun(candidate);
}

function isAmbiguousOrderedListMarkerCandidate(text: string): boolean {
  if (text.length === 0 || text.length > 10) {
    return false;
  }

  const delimiter = text[text.length - 1];
  const hasDelimiter = delimiter === "." || delimiter === ")";

  if (hasDelimiter && text.length === 1) {
    return false;
  }

  for (
    let index = 0;
    index < (hasDelimiter ? text.length - 1 : text.length);
    index += 1
  ) {
    if (!isAsciiDigit(text[index])) {
      return false;
    }
  }

  return hasDelimiter || isAsciiDigit(delimiter);
}

function isShortRepeatedAmbiguousMarkerRun(text: string): boolean {
  if (text.length < 1 || text.length > 2) {
    return false;
  }

  const marker = text[0];

  if (
    marker !== "-" &&
    marker !== "=" &&
    marker !== "*" &&
    marker !== "_" &&
    marker !== "`" &&
    marker !== "~"
  ) {
    return false;
  }

  for (let index = 1; index < text.length; index += 1) {
    if (text[index] !== marker) {
      return false;
    }
  }

  return true;
}

function isTableHeaderCandidateLine(text: string): boolean {
  const row = splitTableRow(text);

  return row !== null && row.hasSeparator && row.cells.length > 0;
}

function isPartialTableHeaderLine(text: string): boolean {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return false;
  }

  const candidate = text.slice(indent.index);

  if (!candidate.startsWith("|")) {
    return false;
  }

  for (let index = 1; index < candidate.length; index += 1) {
    const character = candidate[index] ?? "";

    if (character !== " " && character !== "\t" && character !== "|") {
      return false;
    }
  }

  return true;
}

function isPartialTableDelimiterLine(text: string): boolean {
  const indent = getLeadingIndent(text);

  if (indent.columns > 3) {
    return false;
  }

  const candidate = text.slice(indent.index);

  if (candidate.length === 0 || !candidate.startsWith("|")) {
    return false;
  }

  for (let index = 1; index < candidate.length; index += 1) {
    const character = candidate[index] ?? "";

    if (
      character === "|" ||
      character === " " ||
      character === "\t" ||
      character === ":" ||
      character === "-"
    ) {
      continue;
    }

    return false;
  }

  return true;
}

function stripAmbiguousOpenParagraphTableSuffix(text: string): string {
  if (!text.includes("|")) {
    return text;
  }

  const lastLineBreakIndex = text.lastIndexOf("\n");

  if (lastLineBreakIndex === -1) {
    return isTableHeaderCandidateLine(text) || isPartialTableHeaderLine(text)
      ? ""
      : text;
  }

  const previousLineBreakIndex = text.lastIndexOf("\n", lastLineBreakIndex - 1);
  const previousLineStartIndex = previousLineBreakIndex + 1;
  const previousLine = text.slice(previousLineStartIndex, lastLineBreakIndex);
  const lastLine = text.slice(lastLineBreakIndex + 1);

  if (lastLine.length === 0 && isTableHeaderCandidateLine(previousLine)) {
    if (previousLineStartIndex === 0) {
      return "";
    }

    return text.slice(0, previousLineStartIndex - 1);
  }

  if (
    isTableHeaderCandidateLine(previousLine) &&
    isPartialTableDelimiterLine(lastLine)
  ) {
    if (previousLineStartIndex === 0) {
      return "";
    }

    return text.slice(0, previousLineStartIndex - 1);
  }

  if (
    !isTableHeaderCandidateLine(lastLine) &&
    !isPartialTableHeaderLine(lastLine)
  ) {
    return text;
  }

  const lastLineStartIndex = lastLineBreakIndex + 1;

  if (lastLineStartIndex === 0) {
    return "";
  }

  return text.slice(0, lastLineStartIndex - 1);
}

function getProjectedOpenParagraphText(text: string): string {
  if (isAmbiguousStandaloneOpenParagraphText(text)) {
    return "";
  }

  let projectedText = text;
  const lastLineBreakIndex = projectedText.lastIndexOf("\n");

  if (lastLineBreakIndex === -1) {
    return stripAmbiguousOpenParagraphTableSuffix(projectedText);
  }

  const lastLine = projectedText.slice(lastLineBreakIndex + 1);

  if (isAmbiguousStandaloneOpenParagraphText(lastLine)) {
    projectedText = projectedText.slice(0, lastLineBreakIndex);
  }

  if (
    parseSetextUnderline(lastLine) !== null &&
    !shouldOptimisticallyPromoteSetextHeading(lastLine, false, false)
  ) {
    projectedText = projectedText.slice(0, lastLineBreakIndex);
  }

  return stripAmbiguousOpenParagraphTableSuffix(projectedText);
}

function shouldHideOpenListProjection(block: InternalListBlockState): boolean {
  return getProjectedOpenListItems(block.items, block.open).length === 0;
}

function isAmbiguousOpenListItem(item: InternalListItemState): boolean {
  if (item.hasTrailingSeparatedContent) {
    return false;
  }

  if (item.children.length === 0) {
    return true;
  }

  const onlyChild = item.children[0];

  return (
    item.children.length === 1 &&
    ((onlyChild?.kind === "paragraph" &&
      getProjectedOpenParagraphText(onlyChild.text).length === 0) ||
      (onlyChild?.kind === "list" && shouldHideOpenListProjection(onlyChild)))
  );
}

function getProjectedOpenListItems(
  items: readonly InternalListItemState[],
  open: boolean,
): readonly InternalListItemState[] {
  if (!open || items.length === 0) {
    return items;
  }

  let projectedLength = items.length;

  while (projectedLength > 0) {
    const item = items[projectedLength - 1];

    if (item === undefined || !isAmbiguousOpenListItem(item)) {
      break;
    }

    projectedLength -= 1;
  }

  return projectedLength === items.length
    ? items
    : items.slice(0, projectedLength);
}

function shouldHideOpenTableProjection(
  block: InternalTableBlockState,
): boolean {
  if (!block.open) {
    return false;
  }

  const bodyRows =
    block.header === undefined ? block.rows.slice(1) : block.rows;

  return getProjectedOpenTableBodyRows(bodyRows, block.open).length === 0;
}

function isAmbiguousOpenTableRow(row: InternalTableRowState): boolean {
  return row.cells.every((cell) => cell.text.length === 0);
}

function getProjectedOpenTableBodyRows(
  rows: readonly InternalTableRowState[],
  open: boolean,
): readonly InternalTableRowState[] {
  if (!open || rows.length === 0) {
    return rows;
  }

  let projectedLength = rows.length;

  while (projectedLength > 0) {
    const row = rows[projectedLength - 1];

    if (row === undefined || !isAmbiguousOpenTableRow(row)) {
      break;
    }

    projectedLength -= 1;
  }

  return projectedLength === rows.length
    ? rows
    : rows.slice(0, projectedLength);
}

function shouldOptimisticallyPromoteSetextHeading(
  underlineText: string,
  finalized: boolean,
  hasLineBreak: boolean,
): boolean {
  if (finalized || hasLineBreak) {
    return true;
  }

  const indent = getLeadingIndent(underlineText);
  const marker = underlineText[indent.index];

  if (marker !== "=" && marker !== "-") {
    return false;
  }

  let markerRunLength = 0;

  while (underlineText[indent.index + markerRunLength] === marker) {
    markerRunLength += 1;
  }

  return markerRunLength >= 3;
}

function endsWithParagraph(blocks: readonly InternalBlockState[]): boolean {
  const lastBlock = blocks.at(-1);

  if (lastBlock === undefined) {
    return false;
  }

  switch (lastBlock.kind) {
    case "blockquote":
      return endsWithParagraph(lastBlock.children);
    case "list": {
      const lastItem = lastBlock.items.at(-1);

      return lastItem !== undefined && endsWithParagraph(lastItem.children);
    }
    case "paragraph":
      return true;
    default:
      return false;
  }
}

function getPendingConstructStartOffset(
  blocks: readonly InternalRootBlockState[],
  line: Line,
  finalized: boolean,
  pendingConstruct: PendingConstruct,
  paragraphContinuationStartOffset?: number,
): number {
  if (finalized || line.hasLineBreak) {
    return pendingConstruct.startOffset;
  }

  return (
    paragraphContinuationStartOffset ??
    getTrailingParagraphContinuationStartOffset(blocks, line.startOffset) ??
    pendingConstruct.startOffset
  );
}

function pushPendingConstruct(
  pendingConstructs: PendingConstruct[],
  blocks: readonly InternalRootBlockState[],
  line: Line,
  finalized: boolean,
  pendingConstruct: PendingConstruct | null,
  paragraphContinuationStartOffset?: number,
): void {
  if (pendingConstruct === null) {
    return;
  }

  const startOffset = getPendingConstructStartOffset(
    blocks,
    line,
    finalized,
    pendingConstruct,
    paragraphContinuationStartOffset,
  );

  if (startOffset === pendingConstruct.startOffset) {
    pendingConstructs.push(pendingConstruct);
    return;
  }

  pendingConstructs.push({
    ...pendingConstruct,
    startOffset,
  });
}

function createBlockContinuationTailContext(
  source: string,
): BlockContinuationTailContext {
  const lineStartOffset = getCurrentLineStartOffset(source);

  return {
    currentLineText: source.slice(lineStartOffset),
    lineStartOffset,
    sourceLength: source.length,
  };
}

function updateTrackedBlockContinuationOffsets(
  offsets: TrackedBlockContinuationOffsets,
  block: InternalRootBlockState,
  tailContext: BlockContinuationTailContext,
): void {
  if (block.endOffset <= tailContext.lineStartOffset) {
    offsets.paragraphStartOffset = getParagraphContinuationStartOffset(
      block,
      tailContext.lineStartOffset,
    );
  }

  if (block.endOffset === tailContext.lineStartOffset) {
    offsets.containerStartOffset = getPotentialContainerContinuationStartOffset(
      block,
      tailContext.currentLineText,
      tailContext.lineStartOffset,
    );
  }

  if (
    block.startOffset <= tailContext.lineStartOffset &&
    block.endOffset >= tailContext.lineStartOffset
  ) {
    offsets.htmlStartOffset = getClosedHtmlContinuationStartOffset(
      block,
      tailContext.lineStartOffset,
      tailContext.sourceLength,
    );
  }
}

function getTrackedBlockContinuationStartOffset(
  offsets: TrackedBlockContinuationOffsets | undefined,
  sourceLength: number,
): number | undefined {
  if (offsets === undefined) {
    return undefined;
  }

  return (
    offsets.paragraphStartOffset ??
    offsets.containerStartOffset ??
    offsets.htmlStartOffset ??
    sourceLength
  );
}

function pushParsedBlock(
  blocks: InternalRootBlockState[],
  pendingConstructs: PendingConstruct[],
  line: Line,
  finalized: boolean,
  block: InternalRootBlockState,
  pendingConstruct: PendingConstruct | null,
  tailContext: BlockContinuationTailContext | undefined,
  trackedBlockContinuationOffsets: TrackedBlockContinuationOffsets | undefined,
): void {
  blocks.push(block);

  if (
    tailContext !== undefined &&
    trackedBlockContinuationOffsets !== undefined
  ) {
    updateTrackedBlockContinuationOffsets(
      trackedBlockContinuationOffsets,
      block,
      tailContext,
    );
  }

  pushPendingConstruct(
    pendingConstructs,
    blocks,
    line,
    finalized,
    pendingConstruct,
    trackedBlockContinuationOffsets?.paragraphStartOffset,
  );
}

function reuseHeadingBlock(
  block: InternalHeadingBlockState,
  previousBlock?: InternalBlockState,
): InternalHeadingBlockState {
  return previousBlock?.kind === "heading" &&
    hasSameBlockBase(block, previousBlock) &&
    previousBlock.depth === block.depth &&
    previousBlock.text === block.text
    ? previousBlock
    : block;
}

function reuseThematicBreakBlock(
  block: InternalThematicBreakBlockState,
  previousBlock?: InternalBlockState,
): InternalThematicBreakBlockState {
  return previousBlock?.kind === "thematicBreak" &&
    hasSameBlockBase(block, previousBlock)
    ? previousBlock
    : block;
}

function createIncrementalParagraphNode(
  block: InternalParagraphBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
  knownAppend = false,
): Paragraph | null {
  const previousParagraphBlock =
    previousBlock?.kind === "paragraph" ? previousBlock : undefined;
  const previousParagraphNode =
    previousNode?.type === "paragraph" ? previousNode : undefined;
  const projectedText =
    block.open &&
    (block.text.includes("\n") || !block.plainAppendSafe || block.hasTablePipe)
      ? getProjectedOpenParagraphText(block.text)
      : block.text;

  if (projectedText.length === 0) {
    return null;
  }

  if (
    previousParagraphBlock !== undefined &&
    previousParagraphNode !== undefined &&
    previousParagraphBlock === block
  ) {
    return previousParagraphNode;
  }

  if (
    previousParagraphBlock !== undefined &&
    previousParagraphBlock.inlineCache !== undefined &&
    previousParagraphBlock.inlineCache.text === projectedText &&
    previousParagraphBlock.inlineCache.definitions === definitions &&
    previousParagraphBlock.inlineCache.footnoteDefinitions ===
      footnoteDefinitions
  ) {
    block.inlineCache = previousParagraphBlock.inlineCache;
  } else {
    block.inlineCache = createInlineCache(
      projectedText,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousParagraphBlock?.inlineCache,
      block.open,
      knownAppend,
    );
  }

  const children =
    block.inlineCache === undefined
      ? []
      : getPreferredInlineChildren(block.inlineCache, block.open);
  const node: Paragraph = {
    type: "paragraph",
    children,
  };

  return withFlags(node, getOpenFlags(block.open));
}

function createIncrementalBlockQuoteNode(
  block: InternalBlockQuoteBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): Blockquote {
  const previousBlockQuoteBlock =
    previousBlock?.kind === "blockquote" ? previousBlock : undefined;
  const previousBlockQuoteNode =
    previousNode?.type === "blockquote" ? previousNode : undefined;

  if (
    previousBlockQuoteBlock !== undefined &&
    previousBlockQuoteNode !== undefined &&
    previousBlockQuoteBlock === block
  ) {
    return previousBlockQuoteNode;
  }

  const children = createProjectedBlockChildren(
    block.children,
    inlineOptions,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    previousBlockQuoteBlock?.children,
    previousBlockQuoteNode?.children,
  );

  return withFlags(
    {
      type: "blockquote",
      children,
    },
    getOpenFlags(block.open),
  );
}

function createIncrementalHeadingNode(
  block: InternalHeadingBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): Heading {
  const previousHeadingBlock =
    previousBlock?.kind === "heading" ? previousBlock : undefined;
  const previousHeadingNode =
    previousNode?.type === "heading" ? previousNode : undefined;

  if (
    previousHeadingBlock !== undefined &&
    previousHeadingNode !== undefined &&
    previousHeadingBlock === block
  ) {
    return previousHeadingNode;
  }

  if (
    previousHeadingBlock !== undefined &&
    previousHeadingBlock.inlineCache !== undefined &&
    previousHeadingBlock.text === block.text &&
    previousHeadingBlock.inlineCache.definitions === definitions &&
    previousHeadingBlock.inlineCache.footnoteDefinitions === footnoteDefinitions
  ) {
    block.inlineCache = previousHeadingBlock.inlineCache;
  } else {
    block.inlineCache = createInlineCache(
      block.text,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousHeadingBlock?.inlineCache,
      block.open,
    );
  }

  const children =
    block.inlineCache === undefined
      ? []
      : getPreferredInlineChildren(block.inlineCache, block.open);

  return withFlags(
    {
      type: "heading",
      depth: block.depth,
      children,
    },
    getOpenFlags(block.open),
  );
}

function createCodeNode(
  block: InternalCodeBlockState,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): Code {
  if (
    previousBlock?.kind === "code" &&
    previousNode?.type === "code" &&
    previousBlock === block
  ) {
    return previousNode;
  }

  return withFlags(
    {
      type: "code",
      lang: block.lang ?? null,
      meta: block.meta ?? null,
      value:
        block.value.endsWith("\n") && !block.open
          ? block.value.slice(0, -1)
          : block.value,
    },
    getOpenFlags(block.open),
  );
}

function createMathNode(
  block: InternalMathBlockState,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): MarkdownMath {
  if (
    previousBlock?.kind === "math" &&
    previousNode?.type === "math" &&
    previousBlock === block
  ) {
    return previousNode;
  }

  return withFlags(
    {
      type: "math",
      meta: block.meta ?? null,
      value: block.value,
    },
    getOpenFlags(block.open),
  );
}

function createHtmlBlockNode(
  block: InternalHtmlBlockState,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): Html {
  if (
    previousBlock?.kind === "html" &&
    previousNode?.type === "html" &&
    previousBlock === block
  ) {
    return previousNode;
  }

  return withFlags(
    {
      type: "html",
      value: block.value,
    },
    getOpenFlags(block.open),
  );
}

function createThematicBreakNode(
  block: InternalThematicBreakBlockState,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): ThematicBreak {
  if (
    previousBlock?.kind === "thematicBreak" &&
    previousNode?.type === "thematicBreak" &&
    previousBlock === block
  ) {
    return previousNode;
  }

  return withFlags(
    {
      type: "thematicBreak",
    },
    getOpenFlags(block.open),
  );
}

function createIncrementalListItemNode(
  item: InternalListItemState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousItem?: InternalListItemState,
  previousNode?: ListItem,
): ListItem {
  if (
    previousItem !== undefined &&
    previousNode !== undefined &&
    previousItem === item
  ) {
    return previousNode;
  }

  const children = createProjectedBlockChildren(
    item.children,
    inlineOptions,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    previousItem?.children,
    previousNode?.children,
  );

  return withFlags(
    {
      type: "listItem",
      checked: item.checked ?? null,
      spread: item.spread,
      children,
    },
    getOpenFlags(item.open),
  );
}

function createIncrementalListNode(
  block: InternalListBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): List | null {
  const previousListBlock =
    previousBlock?.kind === "list" ? previousBlock : undefined;
  const previousListNode =
    previousNode?.type === "list" ? previousNode : undefined;

  if (shouldHideOpenListProjection(block)) {
    return null;
  }

  if (
    previousListBlock !== undefined &&
    previousListNode !== undefined &&
    previousListBlock === block
  ) {
    return previousListNode;
  }

  const projectedItems = getProjectedOpenListItems(block.items, block.open);
  const previousProjectedItems =
    previousListBlock === undefined
      ? undefined
      : getProjectedOpenListItems(
          previousListBlock.items,
          previousListBlock.open,
        );
  const nextChildren = projectedItems.map((item, index) =>
    createIncrementalListItemNode(
      item,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousProjectedItems?.[index],
      previousListNode?.children[index],
    ),
  );
  const children =
    previousListNode === undefined
      ? nextChildren
      : reuseArrayIfEntriesEqual(previousListNode.children, nextChildren);
  const node: List = {
    type: "list",
    ordered: block.ordered,
    spread: block.spread,
    start: block.ordered ? (block.start ?? 1) : null,
    children,
  };

  return withFlags(node, getOpenFlags(block.open));
}

function createIncrementalTableCellNode(
  cell: InternalTableCellState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  useOptimisticInlineChildren: boolean,
  previousCell?: InternalTableCellState,
  previousNode?: TableCell,
): TableCell {
  if (
    previousCell !== undefined &&
    previousCell.inlineCache !== undefined &&
    previousCell.text === cell.text &&
    previousCell.inlineCache.definitions === definitions &&
    previousCell.inlineCache.footnoteDefinitions === footnoteDefinitions
  ) {
    cell.inlineCache = previousCell.inlineCache;
  } else {
    cell.inlineCache = createInlineCache(
      cell.text,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousCell?.inlineCache,
      useOptimisticInlineChildren,
    );
  }

  const children =
    cell.inlineCache === undefined
      ? []
      : getPreferredInlineChildren(
          cell.inlineCache,
          useOptimisticInlineChildren,
        );

  if (previousNode !== undefined && previousNode.children === children) {
    return previousNode;
  }

  return {
    type: "tableCell",
    children,
  };
}

function createIncrementalTableRowNode(
  row: InternalTableRowState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  useOptimisticInlineChildren: boolean,
  previousRow?: InternalTableRowState,
  previousNode?: TableRow,
): TableRow {
  const nextChildren = row.cells.map((cell, index) =>
    createIncrementalTableCellNode(
      cell,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      useOptimisticInlineChildren,
      previousRow?.cells[index],
      previousNode?.children[index],
    ),
  );
  const children =
    previousNode === undefined
      ? nextChildren
      : reuseArrayIfEntriesEqual(previousNode.children, nextChildren);

  if (previousNode !== undefined && previousNode.children === children) {
    return previousNode;
  }

  return {
    type: "tableRow",
    children,
  };
}

function createIncrementalTableNode(
  block: InternalTableBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): Table | null {
  const previousTableBlock =
    previousBlock?.kind === "table" ? previousBlock : undefined;
  const previousTableNode =
    previousNode?.type === "table" ? previousNode : undefined;

  if (shouldHideOpenTableProjection(block)) {
    return null;
  }

  if (
    previousTableBlock !== undefined &&
    previousTableNode !== undefined &&
    previousTableBlock === block
  ) {
    return previousTableNode;
  }

  const headerRow = block.header ?? block.rows[0];
  const bodyRows =
    block.header === undefined ? block.rows.slice(1) : block.rows;
  const projectedBodyRows = getProjectedOpenTableBodyRows(bodyRows, block.open);
  const previousHeaderRow =
    previousTableBlock?.header ?? previousTableBlock?.rows[0];
  const previousBodyRows =
    previousTableBlock?.header === undefined
      ? (previousTableBlock?.rows.slice(1) ?? [])
      : (previousTableBlock?.rows ?? []);
  const previousProjectedBodyRows = getProjectedOpenTableBodyRows(
    previousBodyRows,
    previousTableBlock?.open ?? false,
  );

  if (headerRow === undefined) {
    const node: Table = {
      type: "table",
      align: block.align.length === 0 ? null : [...block.align],
      children: [],
    };

    return withFlags(node, getOpenFlags(block.open));
  }

  const nextChildren = [
    createIncrementalTableRowNode(
      headerRow,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      block.open,
      previousHeaderRow,
      previousTableNode?.children[0],
    ),
    ...projectedBodyRows.map((row, index) =>
      createIncrementalTableRowNode(
        row,
        inlineOptions,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        block.open,
        previousProjectedBodyRows[index],
        previousTableNode?.children[index + 1],
      ),
    ),
  ];
  const children =
    previousTableNode === undefined
      ? nextChildren
      : reuseArrayIfEntriesEqual(previousTableNode.children, nextChildren);
  const align =
    previousTableNode !== undefined &&
    areTableAlignmentsEqual(previousTableNode.align ?? undefined, block.align)
      ? (previousTableNode.align ?? [...block.align])
      : [...block.align];
  const node: Table = {
    type: "table",
    align,
    children,
  };

  return withFlags(node, getOpenFlags(block.open));
}

function createIncrementalFootnoteDefinitionNode(
  block: InternalFootnoteDefinitionBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalRootBlockState,
  previousNode?: RootContent,
): FootnoteDefinition {
  const previousFootnoteBlock =
    previousBlock?.kind === "footnoteDefinition" ? previousBlock : undefined;
  const previousFootnoteNode =
    previousNode?.type === "footnoteDefinition" ? previousNode : undefined;

  if (
    previousFootnoteBlock !== undefined &&
    previousFootnoteNode !== undefined &&
    previousFootnoteBlock === block
  ) {
    return previousFootnoteNode;
  }

  const children = createProjectedBlockChildren(
    block.children,
    inlineOptions,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    previousFootnoteBlock?.children,
    previousFootnoteNode?.children,
  );

  return withFlags(
    {
      type: "footnoteDefinition",
      identifier: block.identifier,
      label: block.label,
      children,
    },
    getOpenFlags(block.open),
  );
}

function createIncrementalBlockContentNodeFromBlockState(
  block: InternalBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalBlockState,
  previousNode?: BlockContent,
): BlockContent | null {
  switch (block.kind) {
    case "blockquote":
      return createIncrementalBlockQuoteNode(
        block,
        inlineOptions,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        previousBlock,
        previousNode,
      );
    case "code":
      return createCodeNode(block, previousBlock, previousNode);
    case "heading":
      return createIncrementalHeadingNode(
        block,
        inlineOptions,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        previousBlock,
        previousNode,
      );
    case "math":
      return createMathNode(block, previousBlock, previousNode);
    case "html":
      return createHtmlBlockNode(block, previousBlock, previousNode);
    case "list":
      return createIncrementalListNode(
        block,
        inlineOptions,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        previousBlock,
        previousNode,
      );
    case "table":
      return createIncrementalTableNode(
        block,
        inlineOptions,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        previousBlock,
        previousNode,
      );
    case "paragraph":
      return createIncrementalParagraphNode(
        block,
        inlineOptions,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        previousBlock,
        previousNode,
      );
    case "thematicBreak":
      return createThematicBreakNode(block, previousBlock, previousNode);
  }

  throw new Error("Unknown block kind.");
}

function createIncrementalRootNodeFromBlockState(
  block: InternalRootBlockState,
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlock?: InternalRootBlockState,
  previousNode?: RootContent,
): RootContent | null {
  if (block.kind === "footnoteDefinition") {
    return createIncrementalFootnoteDefinitionNode(
      block,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousBlock,
      previousNode,
    );
  }

  return createIncrementalBlockContentNodeFromBlockState(
    block,
    inlineOptions,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    getPreviousDirectBlock(previousBlock),
    isBlockContentNode(previousNode) ? previousNode : undefined,
  );
}

function createProjectedBlockChildren(
  blocks: readonly InternalBlockState[],
  inlineOptions: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousBlocks?: readonly InternalBlockState[],
  previousNodes?: readonly unknown[],
): BlockContent[] {
  const nextChildren: BlockContent[] = [];

  for (let index = 0; index < blocks.length; index += 1) {
    const child = blocks[index];

    if (child === undefined) {
      continue;
    }

    const projectedChild = createIncrementalBlockContentNodeFromBlockState(
      child,
      inlineOptions,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousBlocks?.[index],
      getPreviousBlockContent(previousNodes, index),
    );

    if (projectedChild !== null) {
      nextChildren.push(projectedChild);
    }
  }

  return previousNodes === undefined
    ? nextChildren
    : reuseArrayIfEntriesEqual(
        previousNodes as readonly BlockContent[] | undefined,
        nextChildren,
      );
}

function normalizeParagraphLine(text: string): string {
  const sanitizedText = text.startsWith(LAZY_CONTINUATION_SENTINEL)
    ? text.slice(LAZY_CONTINUATION_SENTINEL.length)
    : text;

  let startIndex = 0;

  while (isWhitespace(sanitizedText[startIndex])) {
    startIndex += 1;
  }

  return startIndex === 0 ? sanitizedText : sanitizedText.slice(startIndex);
}

function parseParagraph(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  previousBlock?: InternalBlockState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): ParsedBlockResult {
  const startLine = lines[startIndex];

  if (startLine === undefined) {
    throw new Error("Paragraph parsing requires at least one line.");
  }

  const paragraphLines: string[] = [];
  let currentIndex = startIndex;
  let open = false;

  while (currentIndex < lines.length) {
    const currentLine = lines[currentIndex];

    if (currentLine === undefined) {
      break;
    }

    paragraphLines.push(normalizeParagraphLine(currentLine.text));
    const nextIndex = currentIndex + 1;

    if (nextIndex >= lines.length) {
      open = !finalized;
      break;
    }

    const nextLine = lines[nextIndex];

    if (nextLine === undefined) {
      open = !finalized;
      break;
    }

    const setextDepth = parseSetextUnderline(nextLine.text);

    if (
      setextDepth !== null &&
      shouldOptimisticallyPromoteSetextHeading(
        nextLine.text,
        finalized,
        nextLine.hasLineBreak,
      )
    ) {
      const text = paragraphLines.join("\n");
      const open = !nextLine.hasLineBreak && !finalized;
      const headingBlock: InternalHeadingBlockState = {
        kind: "heading",
        startOffset: startLine.startOffset,
        endOffset: nextLine.nextOffset,
        open,
        depth: setextDepth,
        text,
      };
      const block =
        previousBlock?.kind === "heading" &&
        previousBlock.startOffset === headingBlock.startOffset &&
        previousBlock.endOffset === headingBlock.endOffset &&
        previousBlock.open === headingBlock.open &&
        previousBlock.depth === headingBlock.depth &&
        previousBlock.text === headingBlock.text
          ? previousBlock
          : headingBlock;

      return {
        block,
        nextIndex: nextIndex + 1,
        pendingConstruct: open
          ? {
              kind: "heading",
              startOffset: startLine.startOffset,
            }
          : createInlineBracketPendingConstruct(
              text,
              startLine.startOffset,
              finalized,
            ),
      };
    }

    if (isBlankLine(nextLine.text)) {
      break;
    }

    if (canStartTable(lines, nextIndex, inlineOptions.gfmExtensions)) {
      break;
    }

    if (
      !canOnlyStartParagraphLine(nextLine) &&
      isParagraphTerminator(lines, nextIndex, inlineOptions)
    ) {
      break;
    }

    currentIndex = nextIndex;
  }

  const text = paragraphLines.join("\n");
  const endLine = lines[currentIndex];

  if (endLine === undefined) {
    throw new Error("Paragraph parsing requires at least one line.");
  }

  const pendingConstruct: PendingConstruct | null = open
    ? {
        kind: "paragraph",
        startOffset: startLine.startOffset,
      }
    : createInlineBracketPendingConstruct(
        text,
        startLine.startOffset,
        finalized,
      );
  const paragraphBlock: InternalParagraphBlockState = {
    kind: "paragraph",
    startOffset: startLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    hasTablePipe: open && text.includes("|"),
    plainAppendSafe:
      open && paragraphLines.length === 1 && !canStillBecomeBlockStart(text),
    text,
  };
  const block =
    previousBlock?.kind === "paragraph" &&
    previousBlock.startOffset === paragraphBlock.startOffset &&
    previousBlock.endOffset === paragraphBlock.endOffset &&
    previousBlock.open === paragraphBlock.open &&
    previousBlock.hasTablePipe === paragraphBlock.hasTablePipe &&
    previousBlock.plainAppendSafe === paragraphBlock.plainAppendSafe &&
    previousBlock.text === paragraphBlock.text
      ? previousBlock
      : paragraphBlock;

  return {
    block,
    nextIndex: currentIndex + 1,
    pendingConstruct,
  };
}

function parseCodeFence(
  lines: readonly Line[],
  openerIndex: number,
  finalized: boolean,
  previousBlock?: InternalBlockState,
): ParsedBlockResult {
  const openerLine = lines[openerIndex];

  if (openerLine === undefined) {
    throw new Error("Fence parsing requires a valid opener.");
  }

  const fence = parseFence(openerLine);

  if (fence === null) {
    throw new Error("Fence parsing requires a valid opener.");
  }

  let value = "";
  let nextIndex = openerIndex + 1;
  let open = false;
  let closed = false;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined) {
      break;
    }

    if (isFenceCloser(line, fence)) {
      nextIndex += 1;
      closed = true;

      if (!line.hasLineBreak && !finalized) {
        open = true;
        closed = false;
      }

      break;
    }

    value += stripFenceIndent(line.text, fence.indent);

    if (line.hasLineBreak) {
      value += "\n";
    }

    nextIndex += 1;
  }

  if (!closed) {
    open = !finalized;
  }

  const fenceInfo = parseFenceInfo(fence.info);
  const endLine = lines[nextIndex - 1] ?? openerLine;
  const codeBlock: InternalCodeBlockState = {
    kind: "code",
    startOffset: openerLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    value,
    fenced: true,
    marker: fence.marker,
    fenceLength: fence.length,
    ...fenceInfo,
  };
  const block =
    previousBlock?.kind === "code" &&
    previousBlock.startOffset === codeBlock.startOffset &&
    previousBlock.endOffset === codeBlock.endOffset &&
    previousBlock.open === codeBlock.open &&
    previousBlock.value === codeBlock.value &&
    previousBlock.fenced === codeBlock.fenced &&
    previousBlock.lang === codeBlock.lang &&
    previousBlock.meta === codeBlock.meta &&
    previousBlock.marker === codeBlock.marker &&
    previousBlock.fenceLength === codeBlock.fenceLength
      ? previousBlock
      : codeBlock;

  return {
    block,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "codeFence",
          startOffset: openerLine.startOffset,
        }
      : null,
  };
}

function parseMathBlock(
  lines: readonly Line[],
  openerIndex: number,
  finalized: boolean,
  previousBlock?: InternalBlockState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): ParsedBlockResult | null {
  const openerLine = lines[openerIndex];

  if (openerLine === undefined) {
    return null;
  }

  const fence = parseMathFence(openerLine, inlineOptions.mathExtensions);

  if (fence === null) {
    return null;
  }

  if (fence.singleLineValue !== undefined) {
    const mathBlock: InternalMathBlockState = {
      kind: "math",
      startOffset: openerLine.startOffset,
      endOffset: openerLine.nextOffset,
      open: false,
      value: fence.singleLineValue,
      meta: fence.meta,
    };
    const block =
      previousBlock?.kind === "math" &&
      previousBlock.startOffset === mathBlock.startOffset &&
      previousBlock.endOffset === mathBlock.endOffset &&
      previousBlock.open === mathBlock.open &&
      previousBlock.value === mathBlock.value &&
      previousBlock.meta === mathBlock.meta
        ? previousBlock
        : mathBlock;

    return {
      block,
      nextIndex: openerIndex + 1,
      pendingConstruct: null,
    };
  }

  let value = fence.initialValue ?? "";
  let nextIndex = openerIndex + 1;
  let open = !openerLine.hasLineBreak && !finalized;
  let closed = false;

  if (value.length > 0 && openerLine.hasLineBreak) {
    value += "\n";
  }

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined) {
      break;
    }

    if (isMathFenceCloser(line, fence.closer)) {
      nextIndex += 1;
      closed = true;

      if (!line.hasLineBreak && !finalized) {
        open = true;
        closed = false;
      }

      break;
    }

    value += line.text;

    if (line.hasLineBreak) {
      value += "\n";
    }

    nextIndex += 1;
  }

  if (!closed) {
    open = !finalized;
  }

  const endLine = lines[nextIndex - 1] ?? openerLine;
  const mathBlock: InternalMathBlockState = {
    kind: "math",
    startOffset: openerLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    value,
    meta: fence.meta,
  };
  const block =
    previousBlock?.kind === "math" &&
    previousBlock.startOffset === mathBlock.startOffset &&
    previousBlock.endOffset === mathBlock.endOffset &&
    previousBlock.open === mathBlock.open &&
    previousBlock.value === mathBlock.value &&
    previousBlock.meta === mathBlock.meta
      ? previousBlock
      : mathBlock;

  return {
    block,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "mathBlock",
          startOffset: openerLine.startOffset,
        }
      : null,
  };
}

function parseIndentedCode(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  previousBlock?: InternalBlockState,
): ParsedBlockResult {
  const indentedLines: Array<{
    readonly hasLineBreak: boolean;
    readonly text: string;
  }> = [];
  let nextIndex = startIndex;
  let open = false;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined) {
      break;
    }

    if (!isBlankLine(line.text) && countLeadingSpaces(line.text) < 4) {
      break;
    }

    indentedLines.push({
      hasLineBreak: line.hasLineBreak,
      text: countLeadingSpaces(line.text) >= 4 ? stripIndent(line.text, 4) : "",
    });

    nextIndex += 1;

    if (nextIndex >= lines.length) {
      open = !finalized;
      break;
    }
  }

  let trimStartIndex = 0;
  let endIndex = indentedLines.length;

  while (
    trimStartIndex < endIndex &&
    indentedLines[trimStartIndex]?.text === ""
  ) {
    trimStartIndex += 1;
  }

  while (
    endIndex > trimStartIndex &&
    indentedLines[endIndex - 1]?.text === ""
  ) {
    endIndex -= 1;
  }

  const chunks: string[] = [];

  for (const line of indentedLines.slice(trimStartIndex, endIndex)) {
    chunks.push(line.text);

    if (line.hasLineBreak) {
      chunks.push("\n");
    }
  }

  const value = chunks.join("");
  const startLine = lines[startIndex];
  const endLine = lines[nextIndex - 1];

  if (startLine === undefined || endLine === undefined) {
    throw new Error("Indented code parsing requires at least one line.");
  }

  const codeBlock: InternalCodeBlockState = {
    kind: "code",
    startOffset: startLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    value,
    fenced: false,
  };
  const block =
    previousBlock?.kind === "code" &&
    previousBlock.startOffset === codeBlock.startOffset &&
    previousBlock.endOffset === codeBlock.endOffset &&
    previousBlock.open === codeBlock.open &&
    previousBlock.value === codeBlock.value &&
    previousBlock.fenced === codeBlock.fenced
      ? previousBlock
      : codeBlock;

  return {
    block,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "codeBlock",
          startOffset: startLine.startOffset,
        }
      : null,
  };
}

function parseTable(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  previousBlock?: InternalBlockState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): ParsedBlockResult | null {
  if (!canStartTable(lines, startIndex, inlineOptions.gfmExtensions)) {
    return null;
  }

  const headerLine = lines[startIndex];
  const delimiterLine = lines[startIndex + 1];

  if (headerLine === undefined || delimiterLine === undefined) {
    return null;
  }

  const header = splitTableRow(headerLine.text);
  const align = parseTableDelimiterRow(delimiterLine.text);

  if (header === null || align === null) {
    return null;
  }

  const previousTable =
    previousBlock?.kind === "table" ? previousBlock : undefined;
  const columnCount = align.length;
  const headerRow = createTableRowState(
    normalizeTableCells(header.cells, columnCount),
    previousTable?.header,
  );
  const rows: InternalTableRowState[] = [];
  let nextIndex = startIndex + 2;
  let open = false;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined || isBlankLine(line.text)) {
      break;
    }

    const row = splitTableRow(line.text);

    if (row === null) {
      break;
    }

    if (
      !row.hasSeparator &&
      isParagraphTerminator(lines, nextIndex, inlineOptions)
    ) {
      break;
    }

    rows.push(
      createTableRowState(
        normalizeTableCells(row.cells, columnCount),
        previousTable?.rows[rows.length],
      ),
    );
    nextIndex += 1;
  }

  if (nextIndex >= lines.length) {
    open = !finalized;
  }

  const stableAlign =
    previousTable !== undefined &&
    areTableAlignmentsEqual(previousTable.align, align)
      ? previousTable.align
      : align;
  const stableRows =
    previousTable === undefined
      ? rows
      : reuseArrayIfEntriesEqual(previousTable.rows, rows);
  const endLine = lines[nextIndex - 1] ?? delimiterLine;
  const tableBlock: InternalTableBlockState = {
    kind: "table",
    startOffset: headerLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    align: stableAlign,
    header: headerRow,
    rows: stableRows,
  };
  const block =
    previousTable !== undefined &&
    hasSameBlockBase(tableBlock, previousTable) &&
    tableBlock.align === previousTable.align &&
    tableBlock.header === previousTable.header &&
    tableBlock.rows === previousTable.rows
      ? previousTable
      : tableBlock;

  return {
    block,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "table",
          startOffset: headerLine.startOffset,
        }
      : tableMayNeedInlineBracketReparse(headerRow, stableRows)
        ? {
            kind: "inlineBracket",
            startOffset: headerLine.startOffset,
          }
        : null,
  };
}

function parseHtmlBlock(
  line: Line,
  lineIndex: number,
  finalized: boolean,
  lines: readonly Line[],
  previousBlock?: InternalBlockState,
): ParsedBlockResult | null {
  const kind = getHtmlBlockKind(line);

  if (kind === null) {
    return null;
  }

  const collectedLines: Line[] = [line];
  let nextIndex = lineIndex + 1;
  let open = false;
  let foundCloser = kind.kind === "blank-line";

  if (kind.kind === "closer") {
    const closer = kind.ignoreCase ? kind.closer.toLowerCase() : kind.closer;
    foundCloser = kind.ignoreCase
      ? line.text.toLowerCase().includes(closer)
      : line.text.includes(closer);

    while (!foundCloser && nextIndex < lines.length) {
      const nextLine = lines[nextIndex];

      if (nextLine === undefined) {
        break;
      }

      collectedLines.push(nextLine);
      nextIndex += 1;
      foundCloser = kind.ignoreCase
        ? nextLine.text.toLowerCase().includes(closer)
        : nextLine.text.includes(closer);
    }

    open = !foundCloser && !finalized;
  } else {
    while (nextIndex < lines.length) {
      const nextLine = lines[nextIndex];

      if (nextLine === undefined) {
        break;
      }

      if (isBlankLine(nextLine.text)) {
        if (
          !nextLine.hasLineBreak &&
          nextIndex === lines.length - 1 &&
          !finalized
        ) {
          open = true;
        }

        break;
      }

      collectedLines.push(nextLine);
      nextIndex += 1;
    }

    if (nextIndex >= lines.length) {
      open = !finalized;
    }
  }

  let value = "";

  for (const currentLine of collectedLines) {
    value += currentLine.text;

    if (currentLine.hasLineBreak) {
      value += "\n";
    }
  }

  const endLine = collectedLines.at(-1) ?? line;
  const htmlBlock: InternalHtmlBlockState = {
    kind: "html",
    startOffset: line.startOffset,
    endOffset: endLine.nextOffset,
    open,
    value,
  };
  const block =
    previousBlock?.kind === "html" &&
    previousBlock.startOffset === htmlBlock.startOffset &&
    previousBlock.endOffset === htmlBlock.endOffset &&
    previousBlock.open === htmlBlock.open &&
    previousBlock.value === htmlBlock.value
      ? previousBlock
      : htmlBlock;

  return {
    block,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "htmlBlock",
          startOffset: line.startOffset,
        }
      : null,
  };
}

function parseNestedBlocks(
  lines: readonly Line[],
  finalized: boolean,
  previousBlocks?: readonly InternalBlockState[],
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): NestedParseResult {
  const nested = parseBlocksFromLines(
    lines,
    0,
    finalized,
    inlineOptions,
    false,
    previousBlocks,
    undefined,
  );

  return {
    blocks: nested.blocks as readonly InternalBlockState[],
    definitions: nested.definitions,
    hasPendingConstructs: nested.pendingConstructs.length > 0,
  };
}

function appendUniqueDefinitions(
  target: InternalLinkReferenceDefinition[],
  nextDefinitions: readonly InternalLinkReferenceDefinition[],
): void {
  for (const definition of nextDefinitions) {
    if (findReferenceDefinition(target, definition.normalizedLabel) === null) {
      target.push(definition);
    }
  }
}

function appendUniqueFootnoteDefinitions(
  target: InternalFootnoteReferenceDefinition[],
  nextDefinitions: readonly InternalFootnoteReferenceDefinition[],
): void {
  for (const definition of nextDefinitions) {
    if (
      target.some(
        (existingDefinition) =>
          existingDefinition.normalizedLabel === definition.normalizedLabel,
      )
    ) {
      continue;
    }

    target.push(definition);
  }
}

function getPreviousDirectBlock(
  block: InternalRootBlockState | undefined,
): InternalBlockState | undefined {
  return block?.kind === "footnoteDefinition" ? undefined : block;
}

function parseBlockQuote(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  previousBlock?: InternalBlockState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): ParsedBlockResult {
  const startLine = lines[startIndex];

  if (startLine === undefined) {
    throw new Error("Block quote parsing requires at least one line.");
  }

  const previousBlockQuote =
    previousBlock?.kind === "blockquote" ? previousBlock : undefined;
  const nestedLines: Line[] = [];
  let nextIndex = startIndex;
  let open = false;
  let lastQuotedLineWasBlank = false;
  let previousNestedBlocks = previousBlockQuote?.children;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined) {
      break;
    }

    const content = parseBlockQuoteContent(line.text);

    if (content !== null) {
      nestedLines.push({
        ...line,
        text: content,
      });
      lastQuotedLineWasBlank = content.length === 0;
      nextIndex += 1;

      if (nextIndex >= lines.length) {
        open = !finalized;
        break;
      }

      continue;
    }

    if (!isLazyContinuationLine(lines, nextIndex, inlineOptions)) {
      break;
    }

    if (lastQuotedLineWasBlank) {
      break;
    }

    const nestedSoFar = parseNestedBlocks(
      nestedLines,
      true,
      previousNestedBlocks,
      inlineOptions,
    );

    previousNestedBlocks = nestedSoFar.blocks as InternalBlockState[];

    if (!endsWithParagraph(nestedSoFar.blocks)) {
      break;
    }

    nestedLines.push({
      ...line,
      text: `${LAZY_CONTINUATION_SENTINEL}${normalizeParagraphLine(line.text)}`,
    });
    lastQuotedLineWasBlank = false;
    nextIndex += 1;

    if (nextIndex >= lines.length) {
      open = !finalized;
      break;
    }
  }

  if (nextIndex >= lines.length && !startLine.hasLineBreak && !finalized) {
    open = true;
  }

  const nested = parseNestedBlocks(
    nestedLines,
    !open,
    previousBlockQuote?.children,
    inlineOptions,
  );
  open = open || nested.hasPendingConstructs;
  const endLine = lines[nextIndex - 1] ?? startLine;
  const blockQuote: InternalBlockQuoteBlockState = {
    kind: "blockquote",
    startOffset: startLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    children: nested.blocks,
  };
  const block =
    previousBlockQuote !== undefined &&
    hasSameBlockBase(blockQuote, previousBlockQuote) &&
    nested.blocks === previousBlockQuote.children
      ? previousBlockQuote
      : blockQuote;

  return {
    block,
    definitions: nested.definitions,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "blockquote",
          startOffset: startLine.startOffset,
        }
      : null,
  };
}

function isCompatibleListMarker(
  expected: ListMarker,
  actual: ListMarker | null,
): boolean {
  if (actual === null || expected.ordered !== actual.ordered) {
    return false;
  }

  if (expected.ordered) {
    return expected.delimiter === actual.delimiter;
  }

  return expected.bullet === actual.bullet;
}

function parseListItem(
  lines: readonly Line[],
  startIndex: number,
  line: Line,
  marker: ListMarker,
  finalized: boolean,
  previousItem?: InternalListItemState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): {
  readonly definitions: readonly InternalLinkReferenceDefinition[];
  readonly item: InternalListItemState;
  readonly trailingBlankLine: boolean;
  readonly nextIndex: number;
} {
  const taskMarker = inlineOptions.gfmExtensions
    ? parseTaskListMarker(marker.content)
    : null;
  const firstLineText = taskMarker?.text ?? marker.content;
  const nestedLines: Line[] = [
    {
      ...line,
      text: firstLineText,
    },
  ];
  let nextIndex = startIndex + 1;
  let open = false;
  let sawBlankLine = false;
  let consumedAfterBlankLine = false;
  let continuedAfterBlankLine = false;
  let hasParagraphContent = firstLineText.length > 0;
  let lastLineWasBlank = firstLineText.length === 0;
  let previousNestedBlocks = previousItem?.children;

  while (nextIndex < lines.length) {
    const nextLine = lines[nextIndex];

    if (nextLine === undefined) {
      break;
    }

    const nextLineIndent = countLeadingSpaces(nextLine.text);
    const nextLineIsThematicBreak = isThematicBreak(nextLine.text);

    if (nextLineIsThematicBreak && nextLineIndent <= marker.indent) {
      break;
    }

    const nextMarker = nextLineIsThematicBreak
      ? null
      : parseListMarker(nextLine);

    if (nextMarker !== null && nextLineIndent < marker.contentIndent) {
      break;
    }

    if (isBlankLine(nextLine.text)) {
      nestedLines.push({
        ...nextLine,
        text: "",
      });
      sawBlankLine = true;
      lastLineWasBlank = true;
      nextIndex += 1;

      if (nextIndex >= lines.length) {
        open = !finalized;
        break;
      }

      continue;
    }

    if (nextLineIndent < marker.contentIndent) {
      if (
        lastLineWasBlank ||
        !hasParagraphContent ||
        isParagraphTerminator(lines, nextIndex, inlineOptions)
      ) {
        break;
      }

      const nestedSoFar = parseNestedBlocks(
        nestedLines,
        true,
        previousNestedBlocks,
        inlineOptions,
      );

      previousNestedBlocks = nestedSoFar.blocks as InternalBlockState[];

      if (!endsWithParagraph(nestedSoFar.blocks)) {
        break;
      }

      nestedLines.push({
        ...nextLine,
        text: `${LAZY_CONTINUATION_SENTINEL}${normalizeParagraphLine(nextLine.text)}`,
      });
      consumedAfterBlankLine = consumedAfterBlankLine || sawBlankLine;
      continuedAfterBlankLine = continuedAfterBlankLine || sawBlankLine;
      hasParagraphContent = true;
      lastLineWasBlank = false;
      nextIndex += 1;

      if (nextIndex >= lines.length) {
        open = !finalized;
        break;
      }

      continue;
    }

    if (sawBlankLine && !hasParagraphContent && marker.contentBlank) {
      break;
    }

    if (sawBlankLine) {
      const nestedSoFar = parseNestedBlocks(
        nestedLines,
        true,
        previousNestedBlocks,
        inlineOptions,
      );

      previousNestedBlocks = nestedSoFar.blocks as InternalBlockState[];

      const lastDirectBlock = nestedSoFar.blocks.at(-1);
      const directContinuation =
        (nextLineIndent === marker.contentIndent &&
          lastDirectBlock?.kind !== "code") ||
        (lastDirectBlock?.kind === "paragraph" &&
          nextLineIndent >= marker.contentIndent + 4);

      if (directContinuation) {
        continuedAfterBlankLine = true;
      }
    }

    nestedLines.push({
      ...nextLine,
      text: normalizeLeadingIndent(
        stripIndent(nextLine.text, marker.contentIndent),
        marker.contentIndent,
      ),
    });
    consumedAfterBlankLine = consumedAfterBlankLine || sawBlankLine;
    hasParagraphContent = true;
    lastLineWasBlank = false;
    nextIndex += 1;

    if (nextIndex >= lines.length) {
      open = !finalized;
      break;
    }
  }

  if (nextIndex >= lines.length && !line.hasLineBreak && !finalized) {
    open = true;
  }

  const nested = parseNestedBlocks(
    nestedLines,
    !open,
    previousItem?.children,
    inlineOptions,
  );
  open = open || nested.hasPendingConstructs;
  const endLine = lines[nextIndex - 1] ?? line;
  const spread =
    continuedAfterBlankLine ||
    computeListItemSpread(nestedLines, nested.blocks);
  const hasTrailingSeparatedContentAfterLastChild = hasTrailingSeparatedContent(
    nestedLines,
    nested.blocks,
  );
  const item: InternalListItemState = {
    kind: "listItem",
    startOffset: line.startOffset,
    endOffset: endLine.nextOffset,
    checked: taskMarker?.checked ?? null,
    hasTrailingSeparatedContent: hasTrailingSeparatedContentAfterLastChild,
    open,
    spread,
    children: nested.blocks,
  };

  return {
    definitions: nested.definitions,
    trailingBlankLine: sawBlankLine && lastLineWasBlank,
    item:
      previousItem !== undefined &&
      hasSameListItemIdentity(item, previousItem) &&
      item.checked === previousItem.checked &&
      item.hasTrailingSeparatedContent ===
        previousItem.hasTrailingSeparatedContent &&
      item.spread === previousItem.spread &&
      nested.blocks === previousItem.children
        ? previousItem
        : item,
    nextIndex,
  };
}

function parseList(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  firstMarker: ListMarker,
  previousBlock?: InternalBlockState,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
): ParsedBlockResult {
  const firstLine = lines[startIndex];

  if (firstLine === undefined) {
    throw new Error("List parsing requires a valid list marker.");
  }

  const previousList =
    previousBlock?.kind === "list" ? previousBlock : undefined;
  const items: InternalListItemState[] = [];
  const definitions: InternalLinkReferenceDefinition[] = [];
  let nextIndex = startIndex;
  let open = false;
  let itemIndex = 0;
  let spread = false;

  while (nextIndex < lines.length) {
    const line = lines[nextIndex];

    if (line === undefined) {
      break;
    }

    const marker = isThematicBreak(line.text) ? null : parseListMarker(line);

    if (!isCompatibleListMarker(firstMarker, marker)) {
      break;
    }

    if (marker === null) {
      break;
    }

    const result = parseListItem(
      lines,
      nextIndex,
      line,
      marker,
      finalized,
      previousList?.items[itemIndex],
      inlineOptions,
    );

    appendUniqueDefinitions(definitions, result.definitions);
    items.push(result.item);
    open = open || result.item.open;
    nextIndex = result.nextIndex;
    itemIndex += 1;

    if (nextIndex >= lines.length) {
      open = open || !finalized;
      break;
    }

    const nextLine = lines[nextIndex];

    if (
      result.trailingBlankLine &&
      nextLine !== undefined &&
      isCompatibleListMarker(firstMarker, parseListMarker(nextLine))
    ) {
      spread = true;
    }

    while (
      nextIndex < lines.length &&
      isBlankLine(lines[nextIndex]?.text ?? "")
    ) {
      spread = true;
      nextIndex += 1;
    }

    if (nextIndex >= lines.length) {
      break;
    }
  }

  spread = spread || computeListSpread(lines, items);
  const stableItems =
    previousList === undefined
      ? items
      : reuseArrayIfEntriesEqual(previousList.items, items);
  const endLine = lines[nextIndex - 1] ?? firstLine;
  const listBlock: InternalListBlockState = {
    kind: "list",
    startOffset: firstLine.startOffset,
    endOffset: endLine.nextOffset,
    open,
    ordered: firstMarker.ordered,
    start: firstMarker.start,
    spread,
    items: stableItems,
  };
  const block =
    previousList !== undefined &&
    hasSameBlockBase(listBlock, previousList) &&
    listBlock.ordered === previousList.ordered &&
    listBlock.start === previousList.start &&
    listBlock.spread === previousList.spread &&
    listBlock.items === previousList.items
      ? previousList
      : listBlock;

  return {
    block,
    definitions,
    nextIndex,
    pendingConstruct: open
      ? {
          kind: "list",
          startOffset: firstLine.startOffset,
        }
      : null,
  };
}

function parseBlocksFromLines(
  lines: readonly Line[],
  startIndex: number,
  finalized: boolean,
  inlineOptions: InlineParseOptions,
  rootLevel: boolean,
  previousBlocks?: readonly InternalRootBlockState[],
  tailContext?: BlockContinuationTailContext,
): ParsedTail {
  const blocks: InternalRootBlockState[] = [];
  const definitions: InternalLinkReferenceDefinition[] = [];
  const footnoteDefinitions: InternalFootnoteReferenceDefinition[] = [];
  const pendingConstructs: PendingConstruct[] = [];
  const trackedBlockContinuationOffsets =
    tailContext === undefined ? undefined : {};
  let lineIndex = startIndex;
  let blockIndex = 0;

  while (lineIndex < lines.length) {
    const line = lines[lineIndex];

    if (line === undefined) {
      break;
    }

    if (isBlankLine(line.text)) {
      lineIndex += 1;
      continue;
    }

    if (
      rootLevel &&
      inlineOptions.gfmExtensions &&
      canStartFootnoteDefinition(line)
    ) {
      const footnoteDefinition = parseFootnoteDefinition(
        lines,
        lineIndex,
        finalized,
        previousBlocks?.[blockIndex],
        inlineOptions,
      );

      if (footnoteDefinition !== null) {
        if (footnoteDefinition.definitions !== undefined) {
          appendUniqueDefinitions(definitions, footnoteDefinition.definitions);
        }

        if (footnoteDefinition.footnoteDefinitions !== undefined) {
          appendUniqueFootnoteDefinitions(
            footnoteDefinitions,
            footnoteDefinition.footnoteDefinitions,
          );
        }

        pushParsedBlock(
          blocks,
          pendingConstructs,
          line,
          finalized,
          footnoteDefinition.block,
          footnoteDefinition.pendingConstruct,
          tailContext,
          trackedBlockContinuationOffsets,
        );

        lineIndex = footnoteDefinition.nextIndex;
        blockIndex += 1;
        continue;
      }
    }

    const parsedDefinitions = canStartReferenceDefinition(line)
      ? parseLinkReferenceDefinitionsFromLines(lines, lineIndex, finalized)
      : null;

    if (parsedDefinitions !== null) {
      appendUniqueDefinitions(definitions, parsedDefinitions.definitions);
      pushPendingConstruct(
        pendingConstructs,
        blocks,
        line,
        finalized,
        parsedDefinitions.pendingConstruct,
      );
      lineIndex = parsedDefinitions.nextIndex;
      continue;
    }

    if (
      canOnlyStartParagraphLine(line) &&
      (!inlineOptions.gfmExtensions ||
        !line.text.includes("|") ||
        !canStartTable(lines, lineIndex, true))
    ) {
      const paragraph = parseParagraph(
        lines,
        lineIndex,
        finalized,
        getPreviousDirectBlock(previousBlocks?.[blockIndex]),
        inlineOptions,
      );

      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        paragraph.block,
        paragraph.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = paragraph.nextIndex;
      blockIndex += 1;
      continue;
    }

    if (parseBlockQuoteContent(line.text) !== null) {
      const result = parseBlockQuote(
        lines,
        lineIndex,
        finalized,
        getPreviousDirectBlock(previousBlocks?.[blockIndex]),
        inlineOptions,
      );

      if (result.definitions !== undefined) {
        appendUniqueDefinitions(definitions, result.definitions);
      }

      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        result.block,
        result.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = result.nextIndex;
      blockIndex += 1;
      continue;
    }

    const fence = parseFence(line);

    if (fence !== null) {
      const result = parseCodeFence(
        lines,
        lineIndex,
        finalized,
        getPreviousDirectBlock(previousBlocks?.[blockIndex]),
      );

      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        result.block,
        result.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = result.nextIndex;
      blockIndex += 1;
      continue;
    }

    const mathBlock = parseMathBlock(
      lines,
      lineIndex,
      finalized,
      getPreviousDirectBlock(previousBlocks?.[blockIndex]),
      inlineOptions,
    );

    if (mathBlock !== null) {
      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        mathBlock.block,
        mathBlock.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = mathBlock.nextIndex;
      blockIndex += 1;
      continue;
    }

    if (isIndentedCodeLine(line.text)) {
      const result = parseIndentedCode(
        lines,
        lineIndex,
        finalized,
        getPreviousDirectBlock(previousBlocks?.[blockIndex]),
      );

      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        result.block,
        result.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = result.nextIndex;
      blockIndex += 1;
      continue;
    }

    const heading = parseAtxHeading(line);

    if (heading !== null) {
      const open = !line.hasLineBreak && !finalized;
      const pendingConstruct: PendingConstruct | null = open
        ? {
            kind: "heading",
            startOffset: line.startOffset,
          }
        : createInlineBracketPendingConstruct(
            heading.text,
            line.startOffset,
            finalized,
          );
      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        reuseHeadingBlock(
          {
            kind: "heading",
            startOffset: line.startOffset,
            endOffset: line.nextOffset,
            open,
            depth: heading.depth,
            text: heading.text,
          },
          getPreviousDirectBlock(previousBlocks?.[blockIndex]),
        ),
        pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex += 1;
      blockIndex += 1;
      continue;
    }

    if (isThematicBreak(line.text)) {
      const open = !line.hasLineBreak && !finalized;
      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        reuseThematicBreakBlock(
          {
            kind: "thematicBreak",
            startOffset: line.startOffset,
            endOffset: line.nextOffset,
            open,
          },
          getPreviousDirectBlock(previousBlocks?.[blockIndex]),
        ),
        open
          ? {
              kind: "thematicBreak",
              startOffset: line.startOffset,
            }
          : null,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex += 1;
      blockIndex += 1;
      continue;
    }

    const listMarker = parseListMarker(line);

    if (listMarker !== null) {
      const result = parseList(
        lines,
        lineIndex,
        finalized,
        listMarker,
        getPreviousDirectBlock(previousBlocks?.[blockIndex]),
        inlineOptions,
      );

      if (result.definitions !== undefined) {
        appendUniqueDefinitions(definitions, result.definitions);
      }

      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        result.block,
        result.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = result.nextIndex;
      blockIndex += 1;
      continue;
    }

    const htmlBlock = parseHtmlBlock(
      line,
      lineIndex,
      finalized,
      lines,
      getPreviousDirectBlock(previousBlocks?.[blockIndex]),
    );

    if (htmlBlock !== null) {
      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        htmlBlock.block,
        htmlBlock.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = htmlBlock.nextIndex;
      blockIndex += 1;
      continue;
    }

    const table = parseTable(
      lines,
      lineIndex,
      finalized,
      getPreviousDirectBlock(previousBlocks?.[blockIndex]),
      inlineOptions,
    );

    if (table !== null) {
      pushParsedBlock(
        blocks,
        pendingConstructs,
        line,
        finalized,
        table.block,
        table.pendingConstruct,
        tailContext,
        trackedBlockContinuationOffsets,
      );

      lineIndex = table.nextIndex;
      blockIndex += 1;
      continue;
    }

    const paragraph = parseParagraph(
      lines,
      lineIndex,
      finalized,
      getPreviousDirectBlock(previousBlocks?.[blockIndex]),
      inlineOptions,
    );

    pushParsedBlock(
      blocks,
      pendingConstructs,
      line,
      finalized,
      paragraph.block,
      paragraph.pendingConstruct,
      tailContext,
      trackedBlockContinuationOffsets,
    );

    lineIndex = paragraph.nextIndex;
    blockIndex += 1;
  }

  return {
    lines,
    blocks:
      previousBlocks === undefined
        ? blocks
        : reuseArrayIfEntriesEqual(previousBlocks, blocks),
    definitions,
    footnoteDefinitions,
    pendingConstructs,
    blockContinuationStartOffset: getTrackedBlockContinuationStartOffset(
      trackedBlockContinuationOffsets,
      tailContext?.sourceLength ?? 0,
    ),
  };
}

function parseBlocks(
  source: string,
  startOffset: number,
  finalized: boolean,
  inlineOptions: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
  previousBlocks?: readonly InternalRootBlockState[],
  lines?: readonly Line[],
): ParsedTail {
  const sourceLines = lines ?? readLines(source, startOffset);
  const tailContext = createBlockContinuationTailContext(source);
  const parsed = parseBlocksFromLines(
    sourceLines,
    0,
    finalized,
    inlineOptions,
    true,
    previousBlocks,
    tailContext,
  );
  const nextDirtyOffset = getNextDirtyOffset(
    source.length,
    parsed.pendingConstructs,
  );
  const currentLineStartOffset = getCurrentLineStartOffset(source);
  const trailingLineText = source.slice(currentLineStartOffset);
  const trailingWhitespaceStartOffset =
    !finalized &&
    currentLineStartOffset < source.length &&
    isSpaceOrTabOnly(trailingLineText)
      ? currentLineStartOffset
      : undefined;
  const blockContinuationStartOffset =
    parsed.blockContinuationStartOffset === undefined
      ? trailingWhitespaceStartOffset
      : trailingWhitespaceStartOffset === undefined
        ? parsed.blockContinuationStartOffset
        : Math.min(
            parsed.blockContinuationStartOffset,
            trailingWhitespaceStartOffset,
          );
  const pendingConstructs =
    (blockContinuationStartOffset ?? source.length) < nextDirtyOffset
      ? [
          ...parsed.pendingConstructs,
          {
            kind: "blockContinuation" as const,
            startOffset: blockContinuationStartOffset ?? source.length,
          },
        ]
      : parsed.pendingConstructs;

  return {
    lines: sourceLines,
    blocks: parsed.blocks,
    definitions: parsed.definitions,
    footnoteDefinitions: parsed.footnoteDefinitions,
    pendingConstructs,
  };
}

function getNextDirtyOffset(
  sourceLength: number,
  pendingConstructs: readonly PendingConstruct[],
): number {
  if (pendingConstructs.length === 0) {
    return sourceLength;
  }

  let nextDirtyOffset = sourceLength;

  for (let index = 0; index < pendingConstructs.length; index += 1) {
    const construct = pendingConstructs[index];

    if (construct?.kind === "inlineBracket") {
      continue;
    }

    const startOffset = construct?.startOffset ?? sourceLength;

    if (startOffset < nextDirtyOffset) {
      nextDirtyOffset = startOffset;
    }
  }

  return nextDirtyOffset;
}

function retainPrefixInlineBracketPendingConstructs(
  previousConstructs: readonly PendingConstruct[],
  tailStartOffset: number,
  nextConstructs: readonly PendingConstruct[],
): readonly PendingConstruct[] {
  let retainedConstructs: PendingConstruct[] | undefined;

  for (const construct of previousConstructs) {
    if (
      construct.kind !== "inlineBracket" ||
      construct.startOffset >= tailStartOffset
    ) {
      continue;
    }

    retainedConstructs ??= [];
    retainedConstructs.push(construct);
  }

  if (retainedConstructs === undefined) {
    return nextConstructs;
  }

  return [...retainedConstructs, ...nextConstructs];
}

function buildDiagnostics(
  pendingConstructs: readonly PendingConstruct[],
): MarkdownSnapshot["diagnostics"] {
  let diagnostics: Array<MarkdownSnapshot["diagnostics"][number]> | undefined;

  for (const construct of pendingConstructs) {
    if (
      construct.kind === "blockContinuation" ||
      construct.kind === "inlineBracket" ||
      construct.kind === "referenceDefinition"
    ) {
      continue;
    }

    diagnostics ??= [];
    diagnostics.push({
      code: "unfinished-input",
      message: `Input is still unfinished around the trailing ${construct.kind}.`,
      offset: construct.startOffset,
    });
  }

  return diagnostics ?? EMPTY_DIAGNOSTICS;
}

function getPrefixBlockCount(
  blocks: readonly InternalRootBlockState[] | undefined,
  reparseFromOffset: number,
): number {
  if (blocks === undefined) {
    return 0;
  }

  let prefixBlockCount = 0;

  while (
    prefixBlockCount < blocks.length &&
    (blocks[prefixBlockCount]?.endOffset ?? reparseFromOffset + 1) <=
      reparseFromOffset
  ) {
    prefixBlockCount += 1;
  }

  return prefixBlockCount;
}

function getPrefixDefinitionCount<
  TDefinition extends {
    readonly startOffset: number;
  },
>(definitions: readonly TDefinition[], reparseFromOffset: number): number {
  let prefixDefinitionCount = 0;

  while (
    prefixDefinitionCount < definitions.length &&
    (definitions[prefixDefinitionCount]?.startOffset ?? reparseFromOffset) <
      reparseFromOffset
  ) {
    prefixDefinitionCount += 1;
  }

  return prefixDefinitionCount;
}

function mergeReferenceDefinitions(
  previousDefinitions: readonly InternalLinkReferenceDefinition[],
  previousDefinitionIndex: Map<string, InternalLinkReferenceDefinition>,
  reparseFromOffset: number,
  nextDefinitions: readonly InternalLinkReferenceDefinition[],
): {
  readonly definitions: InternalLinkReferenceDefinition[];
  readonly index: Map<string, InternalLinkReferenceDefinition>;
} {
  if (
    nextDefinitions.length === 0 &&
    (previousDefinitions.length === 0 ||
      (previousDefinitions.at(-1)?.startOffset ?? reparseFromOffset) <
        reparseFromOffset)
  ) {
    return {
      definitions: previousDefinitions as InternalLinkReferenceDefinition[],
      index: previousDefinitionIndex,
    };
  }

  const prefixDefinitionCount = getPrefixDefinitionCount(
    previousDefinitions,
    reparseFromOffset,
  );
  const definitions = previousDefinitions.slice(0, prefixDefinitionCount);
  const index = new Map<string, InternalLinkReferenceDefinition>();

  for (
    let definitionIndex = 0;
    definitionIndex < definitions.length;
    definitionIndex += 1
  ) {
    const definition = definitions[definitionIndex];

    if (definition !== undefined) {
      index.set(definition.normalizedLabel, definition);
    }
  }

  for (const definition of nextDefinitions) {
    if (index.has(definition.normalizedLabel)) {
      continue;
    }

    index.set(definition.normalizedLabel, definition);
    definitions.push(definition);
  }

  if (areReferenceDefinitionsEqual(previousDefinitions, definitions)) {
    return {
      definitions: previousDefinitions as InternalLinkReferenceDefinition[],
      index:
        previousDefinitions === definitions
          ? new Map(previousDefinitionIndex)
          : new Map(previousDefinitionIndex),
    };
  }

  return {
    definitions,
    index,
  };
}

function appendReferenceDefinitions(
  previousDefinitions: readonly InternalLinkReferenceDefinition[],
  previousDefinitionIndex: Map<string, InternalLinkReferenceDefinition>,
  nextDefinitions: readonly InternalLinkReferenceDefinition[],
): {
  readonly definitions: InternalLinkReferenceDefinition[];
  readonly index: Map<string, InternalLinkReferenceDefinition>;
} {
  if (nextDefinitions.length === 0) {
    return {
      definitions: previousDefinitions as InternalLinkReferenceDefinition[],
      index: previousDefinitionIndex,
    };
  }

  let definitions: InternalLinkReferenceDefinition[] | undefined;
  let index: Map<string, InternalLinkReferenceDefinition> | undefined;

  for (const definition of nextDefinitions) {
    const currentIndex = index ?? previousDefinitionIndex;

    if (currentIndex.has(definition.normalizedLabel)) {
      continue;
    }

    if (definitions === undefined || index === undefined) {
      definitions = [...previousDefinitions];
      index = new Map(previousDefinitionIndex);
    }

    index.set(definition.normalizedLabel, definition);
    definitions.push(definition);
  }

  if (definitions === undefined || index === undefined) {
    return {
      definitions: previousDefinitions as InternalLinkReferenceDefinition[],
      index: previousDefinitionIndex,
    };
  }

  return {
    definitions,
    index,
  };
}

function mergeFootnoteDefinitions(
  previousDefinitions: readonly InternalFootnoteReferenceDefinition[],
  previousDefinitionIndex: Map<string, InternalFootnoteReferenceDefinition>,
  reparseFromOffset: number,
  nextDefinitions: readonly InternalFootnoteReferenceDefinition[],
): {
  readonly definitions: InternalFootnoteReferenceDefinition[];
  readonly index: Map<string, InternalFootnoteReferenceDefinition>;
} {
  if (
    nextDefinitions.length === 0 &&
    (previousDefinitions.length === 0 ||
      (previousDefinitions.at(-1)?.startOffset ?? reparseFromOffset) <
        reparseFromOffset)
  ) {
    return {
      definitions: previousDefinitions as InternalFootnoteReferenceDefinition[],
      index: previousDefinitionIndex,
    };
  }

  const prefixDefinitionCount = getPrefixDefinitionCount(
    previousDefinitions,
    reparseFromOffset,
  );
  const definitions = previousDefinitions.slice(0, prefixDefinitionCount);
  const index = new Map<string, InternalFootnoteReferenceDefinition>();

  for (
    let definitionIndex = 0;
    definitionIndex < definitions.length;
    definitionIndex += 1
  ) {
    const definition = definitions[definitionIndex];

    if (definition !== undefined) {
      index.set(definition.normalizedLabel, definition);
    }
  }

  for (const definition of nextDefinitions) {
    if (index.has(definition.normalizedLabel)) {
      continue;
    }

    index.set(definition.normalizedLabel, definition);
    definitions.push(definition);
  }

  if (areFootnoteDefinitionsEqual(previousDefinitions, definitions)) {
    return {
      definitions: previousDefinitions as InternalFootnoteReferenceDefinition[],
      index:
        previousDefinitions === definitions
          ? new Map(previousDefinitionIndex)
          : new Map(previousDefinitionIndex),
    };
  }

  return {
    definitions,
    index,
  };
}

function appendFootnoteDefinitions(
  previousDefinitions: readonly InternalFootnoteReferenceDefinition[],
  previousDefinitionIndex: Map<string, InternalFootnoteReferenceDefinition>,
  nextDefinitions: readonly InternalFootnoteReferenceDefinition[],
): {
  readonly definitions: InternalFootnoteReferenceDefinition[];
  readonly index: Map<string, InternalFootnoteReferenceDefinition>;
} {
  if (nextDefinitions.length === 0) {
    return {
      definitions: previousDefinitions as InternalFootnoteReferenceDefinition[],
      index: previousDefinitionIndex,
    };
  }

  let definitions: InternalFootnoteReferenceDefinition[] | undefined;
  let index: Map<string, InternalFootnoteReferenceDefinition> | undefined;

  for (const definition of nextDefinitions) {
    const currentIndex = index ?? previousDefinitionIndex;

    if (currentIndex.has(definition.normalizedLabel)) {
      continue;
    }

    if (definitions === undefined || index === undefined) {
      definitions = [...previousDefinitions];
      index = new Map(previousDefinitionIndex);
    }

    index.set(definition.normalizedLabel, definition);
    definitions.push(definition);
  }

  if (definitions === undefined || index === undefined) {
    return {
      definitions: previousDefinitions as InternalFootnoteReferenceDefinition[],
      index: previousDefinitionIndex,
    };
  }

  return {
    definitions,
    index,
  };
}

function canUseAppendOnlyParseFastPath(
  state: InternalMarkdownState,
  previousResult: InternalMarkdownResult | undefined,
): boolean {
  if (
    previousResult === undefined ||
    state.appendStartOffset === null ||
    state.pendingConstructs.length !== 0 ||
    state.reparseFromOffset !== state.appendStartOffset ||
    state.reparseFromOffset >= state.source.length
  ) {
    return false;
  }

  const previousCharacter =
    state.reparseFromOffset === 0
      ? undefined
      : state.source[state.reparseFromOffset - 1];

  return (
    previousCharacter === undefined ||
    previousCharacter === "\n" ||
    previousCharacter === "\r"
  );
}

function appendBlocks(
  previousBlocks: readonly InternalRootBlockState[],
  tailBlocks: readonly InternalRootBlockState[],
): InternalRootBlockState[] {
  if (tailBlocks.length === 0) {
    return previousBlocks as InternalRootBlockState[];
  }

  if (previousBlocks.length === 0) {
    return [...tailBlocks];
  }

  return [...previousBlocks, ...tailBlocks];
}

function parseAppendedTailFromState(
  state: InternalMarkdownState,
  previousResult: InternalMarkdownResult,
): InternalMarkdownResult {
  const inlineOptions = DEFAULT_INLINE_PARSE_OPTIONS;
  const tailStartOffset = state.reparseFromOffset;
  const previousBlocks = state.blocks;
  const previousChildren = previousResult.snapshot.ast.children;
  const previousDefinitions = state.referenceDefinitions;
  const previousFootnoteDefinitions = state.footnoteDefinitions;
  const lines = getDirtyTailLines(state, tailStartOffset);
  const parsedTail = parseBlocks(
    state.source,
    tailStartOffset,
    state.finalized,
    inlineOptions,
    undefined,
    lines,
  );
  const blocks = appendBlocks(previousBlocks, parsedTail.blocks);
  const { definitions: referenceDefinitions, index: referenceDefinitionIndex } =
    appendReferenceDefinitions(
      previousDefinitions,
      state.referenceDefinitionIndex,
      parsedTail.definitions,
    );
  const { definitions: footnoteDefinitions, index: footnoteDefinitionIndex } =
    appendFootnoteDefinitions(
      previousFootnoteDefinitions,
      state.footnoteDefinitionIndex,
      parsedTail.footnoteDefinitions,
    );
  const canReuseAstNodes =
    referenceDefinitions === previousDefinitions &&
    footnoteDefinitions === previousFootnoteDefinitions;
  const tailChildren: RootContent[] = [];

  for (
    let tailIndex = 0;
    tailIndex < parsedTail.blocks.length;
    tailIndex += 1
  ) {
    const block = parsedTail.blocks[tailIndex];

    if (block === undefined) {
      continue;
    }

    const projectedChild = createIncrementalRootNodeFromBlockState(
      block,
      inlineOptions,
      referenceDefinitions,
      referenceDefinitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );

    if (projectedChild !== null) {
      tailChildren.push(projectedChild);
    }
  }

  let astChildren: RootContent[];

  if (canReuseAstNodes) {
    astChildren =
      tailChildren.length === 0
        ? [...previousChildren]
        : [...previousChildren, ...tailChildren];
  } else {
    astChildren = [];

    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];

      if (block === undefined) {
        continue;
      }

      const projectedChild = createIncrementalRootNodeFromBlockState(
        block,
        inlineOptions,
        referenceDefinitions,
        referenceDefinitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        previousBlocks[blockIndex],
        getPreviousRootContent(previousChildren, blockIndex),
      );

      if (projectedChild !== null) {
        astChildren.push(projectedChild);
      }
    }
  }

  const pendingConstructs = retainPrefixInlineBracketPendingConstructs(
    state.pendingConstructs,
    tailStartOffset,
    parsedTail.pendingConstructs,
  );
  const diagnostics = buildDiagnostics(pendingConstructs);
  const nextDirtyOffset = getNextDirtyOffset(
    state.source.length,
    pendingConstructs,
  );
  const retainedLineCache = createRetainedLineCache(
    state.source,
    parsedTail.lines,
    tailStartOffset,
    nextDirtyOffset,
  );
  const snapshot: MarkdownSnapshot = {
    ast: createProjectedRoot(
      astChildren,
      canReuseAstNodes && tailChildren.length === 0,
      previousResult.snapshot.ast,
    ),
    diagnostics,
    finalized: state.finalized,
    sourceLength: state.source.length,
  };

  state.blocks = blocks;
  state.appendStartOffset = null;
  state.appendedChunk = null;
  state.lineCache = retainedLineCache.lines;
  state.lineCacheSourceLength = retainedLineCache.sourceLength;
  state.lineCacheStartOffset = retainedLineCache.startOffset;
  state.pendingConstructs = pendingConstructs as PendingConstruct[];
  state.referenceDefinitions = referenceDefinitions;
  state.referenceDefinitionIndex = referenceDefinitionIndex;
  state.footnoteDefinitions = footnoteDefinitions;
  state.footnoteDefinitionIndex = footnoteDefinitionIndex;
  state.reparseFromOffset = nextDirtyOffset;

  compactFinalizedState(state);

  return {
    snapshot,
    state,
  };
}

function parseOpenParagraphAppendFromState(
  state: InternalMarkdownState,
  previousResult: InternalMarkdownResult,
): InternalMarkdownResult | undefined {
  const appendStartOffset = state.appendStartOffset;
  const appendedChunk = state.appendedChunk;

  if (
    appendStartOffset === null ||
    appendedChunk === null ||
    state.finalized ||
    appendedChunk.includes("\n") ||
    appendedChunk.includes("\r") ||
    state.source[appendStartOffset - 1] === "\n" ||
    state.source[appendStartOffset - 1] === "\r" ||
    state.pendingConstructs.length !== 1
  ) {
    return undefined;
  }

  const pendingConstruct = state.pendingConstructs[0];

  if (pendingConstruct?.kind !== "paragraph") {
    return undefined;
  }

  const blockIndex = state.blocks.length - 1;
  const previousBlock = state.blocks[blockIndex];

  if (
    previousBlock?.kind !== "paragraph" ||
    !previousBlock.open ||
    !previousBlock.plainAppendSafe ||
    previousBlock.startOffset !== pendingConstruct.startOffset ||
    previousBlock.endOffset !== appendStartOffset
  ) {
    return undefined;
  }

  const previousChildren = previousResult.snapshot.ast.children;

  if (blockIndex >= previousChildren.length) {
    return undefined;
  }

  const block: InternalParagraphBlockState = IS_HERMES_RUNTIME
    ? {
        kind: "paragraph",
        startOffset: previousBlock.startOffset,
        endOffset: state.source.length,
        hasTablePipe: previousBlock.hasTablePipe || appendedChunk.includes("|"),
        open: previousBlock.open,
        plainAppendSafe: previousBlock.plainAppendSafe,
        text: state.source.slice(previousBlock.startOffset),
      }
    : {
        ...previousBlock,
        endOffset: state.source.length,
        hasTablePipe: previousBlock.hasTablePipe || appendedChunk.includes("|"),
        text: state.source.slice(previousBlock.startOffset),
      };
  const projectedChild = createIncrementalParagraphNode(
    block,
    DEFAULT_INLINE_PARSE_OPTIONS,
    state.referenceDefinitions,
    state.referenceDefinitionIndex,
    state.footnoteDefinitions,
    state.footnoteDefinitionIndex,
    previousBlock,
    getPreviousBlockContent(previousChildren, blockIndex),
    true,
  );

  if (projectedChild === null) {
    return undefined;
  }

  const astChildren = previousChildren.slice();
  astChildren[blockIndex] = projectedChild;
  state.blocks[blockIndex] = block;
  state.appendStartOffset = null;
  state.appendedChunk = null;

  return {
    snapshot: {
      ast: createProjectedRoot(astChildren, false, previousResult.snapshot.ast),
      diagnostics: previousResult.snapshot.diagnostics,
      finalized: false,
      sourceLength: state.source.length,
    },
    state,
  };
}

function appendTextToOpenParagraphBlock(
  block: InternalBlockState,
  appendStartOffset: number,
  sourceLength: number,
  appendedChunk: string,
): InternalBlockState | undefined {
  if (block.kind === "paragraph") {
    if (
      !block.open ||
      !block.plainAppendSafe ||
      block.endOffset !== appendStartOffset
    ) {
      return undefined;
    }

    return {
      ...block,
      endOffset: sourceLength,
      hasTablePipe: block.hasTablePipe || appendedChunk.includes("|"),
      text: block.text + appendedChunk,
    };
  }

  if (block.kind === "blockquote") {
    if (!block.open || block.endOffset !== appendStartOffset) {
      return undefined;
    }

    const children = appendTextToOpenParagraphBlockList(
      block.children,
      appendStartOffset,
      sourceLength,
      appendedChunk,
    );

    if (children === undefined) {
      return undefined;
    }

    return {
      ...block,
      children,
      endOffset: sourceLength,
    };
  }

  if (block.kind === "list") {
    return appendTextToOpenParagraphListBlock(
      block,
      appendStartOffset,
      sourceLength,
      appendedChunk,
    );
  }

  return undefined;
}

function appendTextToOpenParagraphBlockList(
  blocks: readonly InternalBlockState[],
  appendStartOffset: number,
  sourceLength: number,
  appendedChunk: string,
): readonly InternalBlockState[] | undefined {
  const lastIndex = blocks.length - 1;
  const block = blocks[lastIndex];

  if (block === undefined) {
    return undefined;
  }

  const updatedBlock = appendTextToOpenParagraphBlock(
    block,
    appendStartOffset,
    sourceLength,
    appendedChunk,
  );

  if (updatedBlock === undefined) {
    return undefined;
  }

  const nextBlocks = blocks.slice();
  nextBlocks[lastIndex] = updatedBlock;
  return nextBlocks;
}

function appendTextToOpenParagraphListBlock(
  block: InternalListBlockState,
  appendStartOffset: number,
  sourceLength: number,
  appendedChunk: string,
): InternalListBlockState | undefined {
  if (!block.open || block.endOffset !== appendStartOffset) {
    return undefined;
  }

  const lastItemIndex = block.items.length - 1;
  const item = block.items[lastItemIndex];

  if (
    item === undefined ||
    !item.open ||
    item.endOffset !== appendStartOffset
  ) {
    return undefined;
  }

  const children = appendTextToOpenParagraphBlockList(
    item.children,
    appendStartOffset,
    sourceLength,
    appendedChunk,
  );

  if (children === undefined) {
    return undefined;
  }

  const items = block.items.slice();
  items[lastItemIndex] = {
    ...item,
    children,
    endOffset: sourceLength,
  };

  return {
    ...block,
    endOffset: sourceLength,
    items,
  };
}

function parseOpenListParagraphAppendFromState(
  state: InternalMarkdownState,
  previousResult: InternalMarkdownResult,
): InternalMarkdownResult | undefined {
  const appendStartOffset = state.appendStartOffset;
  const appendedChunk = state.appendedChunk;

  if (
    appendStartOffset === null ||
    appendedChunk === null ||
    state.finalized ||
    appendedChunk.includes("\n") ||
    appendedChunk.includes("\r") ||
    state.pendingConstructs.length !== 1
  ) {
    return undefined;
  }

  const pendingConstruct = state.pendingConstructs[0];

  if (pendingConstruct?.kind !== "list") {
    return undefined;
  }

  const blockIndex = state.blocks.length - 1;
  const previousBlock = state.blocks[blockIndex];

  if (
    previousBlock?.kind !== "list" ||
    !previousBlock.open ||
    previousBlock.startOffset !== pendingConstruct.startOffset ||
    previousBlock.endOffset !== appendStartOffset
  ) {
    return undefined;
  }

  const block = appendTextToOpenParagraphListBlock(
    previousBlock,
    appendStartOffset,
    state.source.length,
    appendedChunk,
  );

  if (block === undefined) {
    return undefined;
  }

  const previousChildren = previousResult.snapshot.ast.children;

  if (blockIndex >= previousChildren.length) {
    return undefined;
  }

  const projectedChild = createIncrementalRootNodeFromBlockState(
    block,
    DEFAULT_INLINE_PARSE_OPTIONS,
    state.referenceDefinitions,
    state.referenceDefinitionIndex,
    state.footnoteDefinitions,
    state.footnoteDefinitionIndex,
    previousBlock,
    getPreviousRootContent(previousChildren, blockIndex),
  );

  if (projectedChild === null) {
    return undefined;
  }

  const blocks = state.blocks.slice();
  blocks[blockIndex] = block;

  const astChildren = previousChildren.slice();
  astChildren[blockIndex] = projectedChild;

  state.blocks = blocks;
  state.appendStartOffset = null;
  state.appendedChunk = null;

  return {
    snapshot: {
      ast: createProjectedRoot(astChildren, false, previousResult.snapshot.ast),
      diagnostics: previousResult.snapshot.diagnostics,
      finalized: false,
      sourceLength: state.source.length,
    },
    state,
  };
}

function parseFromState(
  state: InternalMarkdownState,
  previousResult?: InternalMarkdownResult,
): InternalMarkdownResult {
  const inlineOptions = DEFAULT_INLINE_PARSE_OPTIONS;
  if (
    previousResult !== undefined &&
    canUseAppendOnlyParseFastPath(state, previousResult)
  ) {
    return parseAppendedTailFromState(state, previousResult);
  }

  if (previousResult !== undefined) {
    const openParagraphAppend = parseOpenParagraphAppendFromState(
      state,
      previousResult,
    );

    if (openParagraphAppend !== undefined) {
      return openParagraphAppend;
    }

    const openListParagraphAppend = parseOpenListParagraphAppendFromState(
      state,
      previousResult,
    );

    if (openListParagraphAppend !== undefined) {
      return openListParagraphAppend;
    }
  }

  const tailStartOffset = state.reparseFromOffset;
  const previousBlocks = state.blocks;
  const previousChildren = previousResult?.snapshot.ast.children;
  const previousDefinitions = state.referenceDefinitions;
  const previousFootnoteDefinitions = state.footnoteDefinitions;
  const prefixBlockCount = getPrefixBlockCount(previousBlocks, tailStartOffset);
  const canReusePreviousTailBlocks =
    !state.finalized ||
    !state.pendingConstructs.some(
      (construct) => construct.kind === "inlineBracket",
    );
  const prefixBlocks =
    prefixBlockCount === 0
      ? []
      : (previousBlocks?.slice(0, prefixBlockCount) ?? []);
  const previousTailBlocks = !canReusePreviousTailBlocks
    ? undefined
    : prefixBlockCount === 0
      ? previousBlocks
      : previousBlocks?.slice(prefixBlockCount);
  const lines = getDirtyTailLines(state, tailStartOffset);
  const parsedTail = parseBlocks(
    state.source,
    tailStartOffset,
    state.finalized,
    inlineOptions,
    previousTailBlocks,
    lines,
  );
  const tailBlocks = parsedTail.blocks;
  const blocks =
    prefixBlocks.length === 0
      ? (tailBlocks as InternalRootBlockState[])
      : reuseArrayIfEntriesEqual(previousBlocks, [
          ...prefixBlocks,
          ...tailBlocks,
        ]);
  const { definitions: referenceDefinitions, index: referenceDefinitionIndex } =
    mergeReferenceDefinitions(
      previousDefinitions,
      state.referenceDefinitionIndex,
      tailStartOffset,
      parsedTail.definitions,
    );
  const { definitions: footnoteDefinitions, index: footnoteDefinitionIndex } =
    mergeFootnoteDefinitions(
      previousFootnoteDefinitions,
      state.footnoteDefinitionIndex,
      tailStartOffset,
      parsedTail.footnoteDefinitions,
    );
  const canReuseAstNodes =
    areReferenceDefinitionsEqual(previousDefinitions, referenceDefinitions) &&
    areFootnoteDefinitionsEqual(
      previousFootnoteDefinitions,
      footnoteDefinitions,
    );
  const prefixChildren = canReuseAstNodes
    ? (previousChildren?.slice(0, prefixBlockCount) ?? [])
    : [];
  const tailChildren: RootContent[] = [];

  if (canReuseAstNodes) {
    for (let tailIndex = 0; tailIndex < tailBlocks.length; tailIndex += 1) {
      const block = tailBlocks[tailIndex];

      if (block === undefined) {
        continue;
      }

      const globalIndex = prefixBlockCount + tailIndex;

      const projectedChild = createIncrementalRootNodeFromBlockState(
        block,
        inlineOptions,
        referenceDefinitions,
        referenceDefinitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        canReusePreviousTailBlocks ? previousBlocks?.[globalIndex] : undefined,
        canReusePreviousTailBlocks
          ? getPreviousRootContent(previousChildren, globalIndex)
          : undefined,
      );

      if (projectedChild !== null) {
        tailChildren.push(projectedChild);
      }
    }
  } else {
    for (let blockIndex = 0; blockIndex < blocks.length; blockIndex += 1) {
      const block = blocks[blockIndex];

      if (block === undefined) {
        continue;
      }

      const projectedChild = createIncrementalRootNodeFromBlockState(
        block,
        inlineOptions,
        referenceDefinitions,
        referenceDefinitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
      );

      if (projectedChild !== null) {
        tailChildren.push(projectedChild);
      }
    }
  }
  const astChildren =
    prefixChildren.length === 0
      ? tailChildren
      : [...prefixChildren, ...tailChildren];
  const canReuseRoot =
    canReuseAstNodes &&
    tailBlocks.length === 0 &&
    previousChildren !== undefined &&
    prefixBlockCount === previousChildren.length;
  const pendingConstructs = retainPrefixInlineBracketPendingConstructs(
    state.pendingConstructs,
    tailStartOffset,
    parsedTail.pendingConstructs,
  );
  const diagnostics = buildDiagnostics(pendingConstructs);
  const nextDirtyOffset = getNextDirtyOffset(
    state.source.length,
    pendingConstructs,
  );
  const retainedLineCache = createRetainedLineCache(
    state.source,
    parsedTail.lines,
    tailStartOffset,
    nextDirtyOffset,
  );
  const snapshot: MarkdownSnapshot = {
    ast: createProjectedRoot(
      astChildren,
      canReuseRoot,
      previousResult?.snapshot.ast,
    ),
    diagnostics,
    finalized: state.finalized,
    sourceLength: state.source.length,
  };

  state.blocks = blocks;
  state.appendStartOffset = null;
  state.appendedChunk = null;
  state.lineCache = retainedLineCache.lines;
  state.lineCacheSourceLength = retainedLineCache.sourceLength;
  state.lineCacheStartOffset = retainedLineCache.startOffset;
  state.pendingConstructs = pendingConstructs as PendingConstruct[];
  state.referenceDefinitions = referenceDefinitions;
  state.referenceDefinitionIndex = referenceDefinitionIndex;
  state.footnoteDefinitions = footnoteDefinitions;
  state.footnoteDefinitionIndex = footnoteDefinitionIndex;
  state.reparseFromOffset = nextDirtyOffset;

  compactFinalizedState(state);

  return {
    snapshot,
    state,
  };
}

export function createInitialMarkdownResult(): InternalMarkdownResult {
  return {
    snapshot: {
      ast: createEmptyRoot(),
      diagnostics: EMPTY_DIAGNOSTICS,
      finalized: false,
      sourceLength: 0,
    },
    state: createInitialParserState(),
  };
}

function parseSource(source: string): MarkdownSnapshot {
  const state = createInitialParserState();

  if (source.length > 0) {
    appendSource(state, source);
  }

  finalizeState(state);

  return parseFromState(state).snapshot;
}

export function parseMarkdown(
  source: string,
  options?: MarkdownOptions,
): MarkdownSnapshot {
  return applyMarkdownTransforms(
    parseSource(source),
    createMarkdownTransformPlan(options?.unstable_transforms),
  );
}

export function appendMarkdownChunk(
  result: InternalMarkdownResult,
  chunk: string,
  nextSource?: string,
): InternalMarkdownResult {
  if (chunk.length === 0) {
    return result;
  }

  return parseFromState(appendSource(result.state, chunk, nextSource), result);
}

export function finalizeMarkdownResult(
  result: InternalMarkdownResult,
): InternalMarkdownResult {
  if (result.snapshot.finalized) {
    return result;
  }

  return parseFromState(finalizeState(result.state), result);
}
