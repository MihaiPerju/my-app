import type {
  InternalBlockState,
  InternalFootnoteDefinitionBlockState,
  InternalListItemState,
  InternalRootBlockState,
} from "./types";

type ContinuationContextBlock =
  | InternalBlockState
  | InternalFootnoteDefinitionBlockState
  | InternalListItemState;

export function getCurrentLineStartOffset(source: string): number {
  let offset = source.length;

  while (offset > 0) {
    const character = source[offset - 1];

    if (character === "\n" || character === "\r") {
      break;
    }

    offset -= 1;
  }

  return offset;
}

function advanceIndentColumn(column: number, character: string): number {
  if (character === "\t") {
    return column + (4 - (column % 4));
  }

  return column + 1;
}

function parsePrefixIndent(text: string): {
  readonly columns: number;
  readonly index: number;
} {
  let columns = 0;
  let index = 0;

  while (index < text.length) {
    const character = text[index];

    if (character !== " " && character !== "\t") {
      break;
    }

    columns = advanceIndentColumn(columns, character);
    index += 1;
  }

  return {
    columns,
    index,
  };
}

function isAsciiDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return code >= 0x30 && code <= 0x39;
}

function canStillBecomeBlockQuoteContinuation(text: string): boolean {
  const indent = parsePrefixIndent(text);

  return indent.columns <= 3 && indent.index === text.length;
}

function canStillBecomeListContinuation(text: string): boolean {
  const indent = parsePrefixIndent(text);

  if (indent.columns > 3) {
    return false;
  }

  if (indent.index === text.length) {
    return true;
  }

  let digitCount = 0;
  let index = indent.index;

  while (index < text.length && isAsciiDigit(text[index])) {
    digitCount += 1;
    index += 1;
  }

  return digitCount > 0 && digitCount <= 9 && index === text.length;
}

export function getParagraphContinuationStartOffset(
  block: ContinuationContextBlock | undefined,
  lineStartOffset: number,
): number | undefined {
  if (block === undefined || block.endOffset !== lineStartOffset) {
    return undefined;
  }

  switch (block.kind) {
    case "paragraph":
      return block.startOffset;
    case "blockquote": {
      const lastChild = block.children.at(-1);

      return getParagraphContinuationStartOffset(lastChild, lineStartOffset) ===
        undefined
        ? undefined
        : block.startOffset;
    }
    case "footnoteDefinition": {
      const lastChild = block.children.at(-1);

      return getParagraphContinuationStartOffset(lastChild, lineStartOffset) ===
        undefined
        ? undefined
        : block.startOffset;
    }
    case "list": {
      const lastItem = block.items.at(-1);

      return getParagraphContinuationStartOffset(lastItem, lineStartOffset) ===
        undefined
        ? undefined
        : block.startOffset;
    }
    case "listItem": {
      const lastChild = block.children.at(-1);

      return getParagraphContinuationStartOffset(lastChild, lineStartOffset) ===
        undefined
        ? undefined
        : block.startOffset;
    }
    default:
      return undefined;
  }
}

export function getTrailingParagraphContinuationStartOffset(
  blocks: readonly InternalRootBlockState[],
  lineStartOffset: number,
): number | undefined {
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    const block = blocks[index];

    if (block === undefined) {
      continue;
    }

    if (block.endOffset > lineStartOffset) {
      continue;
    }

    return getParagraphContinuationStartOffset(block, lineStartOffset);
  }

  return undefined;
}

export function getClosedHtmlContinuationStartOffset(
  block: ContinuationContextBlock | undefined,
  lineStartOffset: number,
  sourceLength: number,
): number | undefined {
  if (block === undefined || block.endOffset !== sourceLength) {
    return undefined;
  }

  switch (block.kind) {
    case "html":
      return block.open || lineStartOffset < block.startOffset
        ? undefined
        : block.startOffset;
    case "blockquote": {
      const lastChild = block.children.at(-1);

      return getClosedHtmlContinuationStartOffset(
        lastChild,
        lineStartOffset,
        sourceLength,
      ) === undefined
        ? undefined
        : block.startOffset;
    }
    case "footnoteDefinition": {
      const lastChild = block.children.at(-1);

      return getClosedHtmlContinuationStartOffset(
        lastChild,
        lineStartOffset,
        sourceLength,
      ) === undefined
        ? undefined
        : block.startOffset;
    }
    case "list": {
      const lastItem = block.items.at(-1);

      return getClosedHtmlContinuationStartOffset(
        lastItem,
        lineStartOffset,
        sourceLength,
      ) === undefined
        ? undefined
        : block.startOffset;
    }
    case "listItem": {
      const lastChild = block.children.at(-1);

      return getClosedHtmlContinuationStartOffset(
        lastChild,
        lineStartOffset,
        sourceLength,
      ) === undefined
        ? undefined
        : block.startOffset;
    }
    default:
      return undefined;
  }
}

export function getPotentialContainerContinuationStartOffset(
  block: ContinuationContextBlock | undefined,
  currentLineText: string,
  lineStartOffset: number,
): number | undefined {
  if (block === undefined || block.endOffset !== lineStartOffset) {
    return undefined;
  }

  switch (block.kind) {
    case "blockquote":
      return canStillBecomeBlockQuoteContinuation(currentLineText)
        ? block.startOffset
        : undefined;
    case "list":
      return canStillBecomeListContinuation(currentLineText)
        ? block.startOffset
        : undefined;
    case "footnoteDefinition": {
      const lastChild = block.children.at(-1);

      return getPotentialContainerContinuationStartOffset(
        lastChild,
        currentLineText,
        lineStartOffset,
      ) === undefined
        ? undefined
        : block.startOffset;
    }
    case "listItem": {
      const lastChild = block.children.at(-1);

      return getPotentialContainerContinuationStartOffset(
        lastChild,
        currentLineText,
        lineStartOffset,
      ) === undefined
        ? undefined
        : block.startOffset;
    }
    default:
      return undefined;
  }
}
