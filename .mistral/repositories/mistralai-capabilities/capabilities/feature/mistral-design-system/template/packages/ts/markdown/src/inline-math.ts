import type { InlineMath } from "mdast";

const UNICODE_WHITESPACE = /\p{White_Space}/u;

export type ParsedInlineMath = {
  readonly nextIndex: number;
  readonly node: InlineMath;
};

export type DollarInlineMathParseResult =
  | ParsedInlineMath
  | "literal"
  | "unresolved";

function createInlineMath(value: string): InlineMath {
  return {
    type: "inlineMath",
    value,
  };
}

function isWhitespaceCharacter(character: string | undefined): boolean {
  return character !== undefined && UNICODE_WHITESPACE.test(character);
}

function isAsciiAlphaNumeric(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function getCharacterAfter(
  text: string,
  startIndex: number,
): string | undefined {
  if (startIndex >= text.length) {
    return undefined;
  }

  const firstCodeUnit = text.charCodeAt(startIndex);

  if (
    (firstCodeUnit & 0xfc00) === 0xd800 &&
    startIndex + 1 < text.length &&
    (text.charCodeAt(startIndex + 1) & 0xfc00) === 0xdc00
  ) {
    return text.slice(startIndex, startIndex + 2);
  }

  return text[startIndex];
}

function getCharacterBefore(
  text: string,
  endIndex: number,
): string | undefined {
  if (endIndex <= 0) {
    return undefined;
  }

  const lastCodeUnit = text.charCodeAt(endIndex - 1);

  if (
    (lastCodeUnit & 0xfc00) === 0xdc00 &&
    endIndex >= 2 &&
    (text.charCodeAt(endIndex - 2) & 0xfc00) === 0xd800
  ) {
    return text.slice(endIndex - 2, endIndex);
  }

  return text[endIndex - 1];
}

function isCharacterEscaped(text: string, index: number): boolean {
  let slashCount = 0;
  let current = index - 1;

  while (current >= 0 && text[current] === "\\") {
    slashCount += 1;
    current -= 1;
  }

  return slashCount % 2 === 1;
}

function hasValidInlineMathDollarContext(
  text: string,
  startIndex: number,
): boolean {
  if (
    (text[startIndex] ?? "") !== "$" ||
    (text[startIndex + 1] ?? "") === "$"
  ) {
    return false;
  }

  const openerPrevious = getCharacterBefore(text, startIndex);
  const previousDollarIsEscaped =
    openerPrevious === "$" && isCharacterEscaped(text, startIndex - 1);

  return !(
    (openerPrevious === "$" && !previousDollarIsEscaped) ||
    isAsciiAlphaNumeric(openerPrevious)
  );
}

export function isPotentialInlineMathDollarStart(
  text: string,
  startIndex: number,
): boolean {
  if (!hasValidInlineMathDollarContext(text, startIndex)) {
    return false;
  }

  const openerNext = getCharacterAfter(text, startIndex + 1);

  return !(
    openerNext === "$" ||
    openerNext === "\n" ||
    openerNext === "\r" ||
    isWhitespaceCharacter(openerNext)
  );
}

export function isPotentialInlineMathDollarOpener(
  text: string,
  startIndex: number,
): boolean {
  return (
    isPotentialInlineMathDollarStart(text, startIndex) &&
    getCharacterAfter(text, startIndex + 1) !== undefined
  );
}

export function parseDollarInlineMath(
  text: string,
  startIndex: number,
): DollarInlineMathParseResult {
  if (!isPotentialInlineMathDollarStart(text, startIndex)) {
    return "literal";
  }

  if (!isPotentialInlineMathDollarOpener(text, startIndex)) {
    return "unresolved";
  }

  let index = startIndex + 1;

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character === "\\") {
      index += text[index + 1] === undefined ? 1 : 2;
      continue;
    }

    if (character === "\n" || character === "\r") {
      return "literal";
    }

    if (character !== "$") {
      index += 1;
      continue;
    }

    const previousCharacter = text[index - 1];

    if (previousCharacter === undefined || previousCharacter === "\\") {
      index += 1;
      continue;
    }

    if (isWhitespaceCharacter(previousCharacter)) {
      return "literal";
    }

    const closerNext = getCharacterAfter(text, index + 1);
    const value = text.slice(startIndex + 1, index);

    if (
      closerNext === "$" ||
      isAsciiAlphaNumeric(closerNext) ||
      value.length === 0 ||
      value.trim() !== value
    ) {
      index += 1;
      continue;
    }

    return {
      nextIndex: index + 1,
      node: createInlineMath(value),
    };
  }

  return "unresolved";
}

export function parseParenthesizedInlineMath(
  text: string,
  startIndex: number,
): ParsedInlineMath | null {
  if (!text.startsWith("\\(", startIndex)) {
    return null;
  }

  const openerNext = getCharacterAfter(text, startIndex + 2);

  if (openerNext === undefined || openerNext === "\n" || openerNext === "\r") {
    return null;
  }

  let index = startIndex + 2;

  while (index < text.length) {
    if (text.startsWith("\\)", index)) {
      const previousCharacter = getCharacterBefore(text, index);
      const value = text.slice(startIndex + 2, index);
      const trimmedValue = value.trim();

      if (
        previousCharacter === undefined ||
        previousCharacter === "\\" ||
        trimmedValue.length === 0
      ) {
        index += 2;
        continue;
      }

      return {
        nextIndex: index + 2,
        node: createInlineMath(trimmedValue),
      };
    }

    const character = text[index] ?? "";

    if (character === "\n" || character === "\r") {
      return null;
    }

    index += 1;
  }

  return null;
}
