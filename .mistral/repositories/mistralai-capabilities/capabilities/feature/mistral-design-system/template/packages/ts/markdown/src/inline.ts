import type {
  Break,
  Delete,
  Emphasis,
  FootnoteReference,
  Html,
  Image,
  InlineCode,
  Link,
  PhrasingContent,
  Strong,
  Text,
} from "mdast";

import {
  decodeCharacterReferences,
  matchCharacterReference,
  matchTrailingCharacterReference,
} from "./character-reference";
import {
  isHtmlDeclarationStart,
  scanCompleteClosingHtmlTag,
  scanCompleteOpeningHtmlTag,
} from "./html-scan";
import {
  parseDollarInlineMath,
  parseParenthesizedInlineMath,
} from "./inline-math";
import {
  containsBlankLine,
  containsLineEnding,
  isEscapablePunctuation,
  normalizeReferenceLabel,
} from "./text-normalize";
import type {
  InternalFootnoteReferenceDefinition,
  InternalInlineEvent,
  InternalInlineAppendContinuation,
  InternalInlineCache,
  InternalLinkReferenceDefinition,
  MarkdownNodeFlags,
} from "./types";

const PUNCTUATION_OR_SYMBOL = /[\p{P}\p{S}]/u;
const UNICODE_WHITESPACE = /\p{White_Space}/u;

type Line = {
  readonly endOffset: number;
  readonly hasLineBreak: boolean;
  readonly nextOffset: number;
  readonly startOffset: number;
  readonly text: string;
};

type CodeSpan = {
  readonly nextIndex: number;
  readonly value: string;
};

export type InlineParseOptions = {
  readonly allowImages: boolean;
  readonly allowLinks: boolean;
  readonly gfmExtensions: boolean;
  readonly mathExtensions: boolean;
};

type ParsedInlineNode = {
  readonly nextIndex: number;
  readonly node: PhrasingContent;
};

type ParsedLinkDestination = {
  readonly nextIndex: number;
  readonly title?: string;
  readonly url: string;
};

type ParsedLinkReferenceTail = {
  readonly definition: InternalLinkReferenceDefinition;
  readonly nextIndex: number;
};

type InlineDelimiterToken = Extract<InternalInlineEvent, { kind: "delimiter" }>;
type InlineEvent = InternalInlineEvent;

type ScannedInlineEvents = {
  readonly appendSensitiveStart?: number;
  readonly hasEmphasisDelimiters: boolean;
  readonly unresolvedStart?: number;
  readonly events: readonly InlineEvent[];
};

type ScannedInlineState = {
  readonly appendSensitiveStart?: number;
  readonly unresolvedStart?: number;
};

type InlineScannerHandlers = {
  appendText(value: string): void;
  appendNode(node: PhrasingContent): void;
  appendDelimiter(token: InlineDelimiterToken): void;
  openBracket?(labelStartIndex: number, image: boolean): void;
  closeBracket?(closeBracketIndex: number): number;
};

type MutableDelimiterEntry = {
  canClose: boolean;
  canOpen: boolean;
  length: number;
  marker: "*" | "_" | "~";
  next: MutableDelimiterEntry | null;
  node: MutableInlineNode;
  originalLength: number;
  previous: MutableDelimiterEntry | null;
  startIndex: number;
};

type MutableInlineNode = {
  next: MutableInlineNode | null;
  node: PhrasingContent | null;
  previous: MutableInlineNode | null;
  projectedChildCount: number;
};

type MutableInlineState = {
  appendSensitiveStart?: number;
  projectedChildren?: readonly PhrasingContent[];
  projectionDirtyAnchor: MutableInlineNode | null;
  readonly root: MutableInlineNode;
  lastDelimiter: MutableDelimiterEntry | null;
};

type MutableBracketEntry = {
  active: boolean;
  bracketAfter: boolean;
  image: boolean;
  labelStartIndex: number;
  node: MutableInlineNode;
  previous: MutableBracketEntry | null;
  previousDelimiter: MutableDelimiterEntry | null;
};

type MutableInlineParserState = MutableInlineState & {
  definitions: readonly InternalLinkReferenceDefinition[];
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>;
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[];
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >;
  lastBracket: MutableBracketEntry | null;
  options: InlineParseOptions;
  tail: MutableInlineNode;
  text: string;
};

type ParsedBracketInlineChildren = {
  readonly appendSafeOffset: number;
  readonly appendSensitiveStart?: number;
  readonly children: PhrasingContent[];
  readonly explicitAppendSensitiveStart?: number;
  readonly explicitUnresolvedStart?: number;
  readonly state: MutableInlineParserState;
  readonly unresolvedStart?: number;
};

type ParsedInlineChildren = {
  readonly appendSafeOffset: number;
  readonly children: PhrasingContent[];
  readonly appendSensitiveStart?: number;
  readonly events?: readonly InlineEvent[];
  readonly resumeState?: unknown;
  readonly unresolvedStart?: number;
};

type InlineProjectionMode = "exact" | "optimistic";

type BracketInlineResumeState = {
  readonly kind: "brackets";
  readonly state: MutableInlineParserState;
};

export const DEFAULT_INLINE_PARSE_OPTIONS = {
  allowImages: true,
  allowLinks: true,
  gfmExtensions: true,
  mathExtensions: true,
} as const satisfies InlineParseOptions;

const SUPPORTED_LITERAL_AUTOLINK_SCHEMES = [
  "http://",
  "https://",
  "ftp://",
  "www.",
  "mailto:",
  "xmpp:",
] as const;

const OPTIMISTIC_INLINE_FLAGS = {
  unfinished: true,
  optimistic: true,
} as const satisfies MarkdownNodeFlags;

function createText(value: string): Text {
  return {
    type: "text",
    value,
  };
}

function createHardBreak(): Break {
  return {
    type: "break",
  };
}

function withInlineFlags<
  TNode extends { readonly type: string; data?: unknown },
>(node: TNode, flags?: MarkdownNodeFlags): TNode {
  if (flags === undefined) {
    return node;
  }

  return {
    ...node,
    data: {
      ...((node.data as Record<string, unknown> | undefined) ?? {}),
      mistralMarkdown: flags,
    },
  } as TNode;
}

function createEmphasis(children: PhrasingContent[]): Emphasis {
  return {
    type: "emphasis",
    children,
  };
}

function createDelete(children: PhrasingContent[]): Delete {
  return {
    type: "delete",
    children,
  };
}

function createStrong(children: PhrasingContent[]): Strong {
  return {
    type: "strong",
    children,
  };
}

function createInlineCode(value: string): InlineCode {
  return {
    type: "inlineCode",
    value,
  };
}

function createHtml(value: string): Html {
  return {
    type: "html",
    value,
  };
}

function createFootnoteReference(
  identifier: string,
  label?: string,
): FootnoteReference {
  return {
    type: "footnoteReference",
    identifier,
    label: label ?? null,
  };
}

function createLink(
  children: PhrasingContent[],
  url: string,
  title?: string,
): Link {
  return {
    type: "link",
    children,
    title: title ?? null,
    url,
  };
}

function createImage(url: string, alt: string, title?: string): Image {
  return {
    type: "image",
    alt,
    title: title ?? null,
    url,
  };
}

function isWhitespaceCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  if (character.length === 1) {
    const code = character.charCodeAt(0);

    if (code <= 0x7f) {
      return (
        code === 0x20 ||
        code === 0x09 ||
        code === 0x0a ||
        code === 0x0d ||
        code === 0x0c ||
        code === 0x0b
      );
    }
  }

  return UNICODE_WHITESPACE.test(character);
}

function isPunctuationCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  if (character.length === 1) {
    const code = character.charCodeAt(0);

    if (code <= 0x7f) {
      return (
        (code >= 0x21 && code <= 0x2f) ||
        (code >= 0x3a && code <= 0x40) ||
        (code >= 0x5b && code <= 0x60) ||
        (code >= 0x7b && code <= 0x7e)
      );
    }
  }

  return PUNCTUATION_OR_SYMBOL.test(character);
}

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
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

function isHexDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isAsciiWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function isLinkWhitespaceCharacter(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r"
  );
}

function normalizeLinkDestination(value: string): string {
  const encoded = encodeURI(value);
  let normalized = "";
  let index = 0;

  while (index < encoded.length) {
    if (
      encoded[index] === "%" &&
      encoded[index + 1] === "2" &&
      encoded[index + 2] === "5" &&
      isHexDigit(encoded[index + 3]) &&
      isHexDigit(encoded[index + 4])
    ) {
      normalized += `%${encoded.slice(index + 3, index + 5)}`;
      index += 5;
      continue;
    }

    normalized += encoded[index] ?? "";
    index += 1;
  }

  return normalized;
}

function hasLiteralAutolinkBoundaryBefore(
  text: string,
  startIndex: number,
): boolean {
  const before = getCharacterBefore(text, startIndex);

  return before === undefined || !isAsciiAlphaNumeric(before);
}

function countCharacter(value: string, character: string): number {
  let count = 0;
  let index = 0;

  while (index < value.length) {
    const currentCharacter = getCharacterAfter(value, index);

    if (currentCharacter === character) {
      count += 1;
    }

    index =
      currentCharacter === undefined
        ? index + 1
        : index + currentCharacter.length;
  }

  return count;
}

function trimLiteralAutolinkSuffix(value: string): string {
  let endIndex = value.length;

  while (endIndex > 0) {
    const trailingCharacter = getCharacterBefore(value, endIndex);

    if (trailingCharacter === ";") {
      const entityMatch = matchTrailingCharacterReference(value, endIndex);

      if (entityMatch !== null) {
        endIndex -= entityMatch.length;
        continue;
      }
    }

    if (
      trailingCharacter === "." ||
      trailingCharacter === "," ||
      trailingCharacter === ":" ||
      trailingCharacter === ";" ||
      trailingCharacter === "?" ||
      trailingCharacter === "!" ||
      trailingCharacter === '"' ||
      trailingCharacter === "'"
    ) {
      endIndex -= trailingCharacter.length;
      continue;
    }

    if (
      trailingCharacter === ")" &&
      countCharacter(value.slice(0, endIndex), "(") <
        countCharacter(value.slice(0, endIndex), ")")
    ) {
      endIndex -= 1;
      continue;
    }

    if (
      trailingCharacter !== undefined &&
      (trailingCharacter === "*" ||
        trailingCharacter === "_" ||
        trailingCharacter === "~")
    ) {
      let runStart = endIndex - trailingCharacter.length;

      while (runStart > 0) {
        const previousCharacter = getCharacterBefore(value, runStart);

        if (previousCharacter !== trailingCharacter) {
          break;
        }

        runStart -= previousCharacter.length;
      }

      const runLength = endIndex - runStart;
      const beforeRun = getCharacterBefore(value, runStart);

      if (
        beforeRun !== undefined &&
        !isWhitespaceCharacter(beforeRun) &&
        (trailingCharacter !== "~" || runLength >= 2)
      ) {
        endIndex = runStart;
        continue;
      }
    }

    break;
  }

  return value.slice(0, endIndex);
}

function consumeLiteralAutolink(text: string, startIndex: number): string {
  let endIndex = startIndex;

  while (endIndex < text.length) {
    const character = getCharacterAfter(text, endIndex);

    if (
      character === undefined ||
      character === "<" ||
      character === "[" ||
      character === "]" ||
      isWhitespaceCharacter(character)
    ) {
      break;
    }

    endIndex += character.length;
  }

  return trimLiteralAutolinkSuffix(text.slice(startIndex, endIndex));
}

function isValidWwwAutolinkHost(host: string): boolean {
  const labels = host.split(".");

  if (labels.length < 2) {
    return false;
  }

  for (let index = 0; index < labels.length; index += 1) {
    const label = labels[index];

    if (label === undefined || label.length === 0) {
      return false;
    }

    let offset = 0;

    while (offset < label.length) {
      const character = getCharacterAfter(label, offset);

      if (character === undefined) {
        break;
      }

      if (character === "_") {
        if (index !== 0) {
          return false;
        }
      } else if (
        character === "." ||
        character === "/" ||
        character === "\\" ||
        character === '"' ||
        character === "'" ||
        character === "<" ||
        character === ">" ||
        character === "(" ||
        character === ")" ||
        isWhitespaceCharacter(character)
      ) {
        return false;
      }

      offset += character.length;
    }
  }

  return true;
}

function scanEmailDomainLabelEnd(
  text: string,
  startIndex: number,
): number | null {
  if (!isAsciiAlphaNumeric(text[startIndex])) {
    return null;
  }

  let index = startIndex + 1;

  while (index - startIndex < 63) {
    const character = text[index];

    if (character !== "-" && !isAsciiAlphaNumeric(character)) {
      break;
    }

    index += 1;
  }

  return text[index - 1] === "-" ? null : index;
}

function scanEmailLiteralEnd(text: string, startIndex: number): number | null {
  let index = startIndex;

  while (isEmailLocalPartCharacter(text[index])) {
    index += 1;
  }

  if (index === startIndex || text[index] !== "@") {
    return null;
  }

  index += 1;

  const firstLabelEnd = scanEmailDomainLabelEnd(text, index);

  if (firstLabelEnd === null) {
    return null;
  }

  index = firstLabelEnd;

  if (text[index] !== ".") {
    return null;
  }

  index += 1;

  const nextLabelEnd = scanEmailDomainLabelEnd(text, index);

  if (nextLabelEnd === null) {
    return null;
  }

  index = nextLabelEnd;

  while (text[index] === ".") {
    const labelEnd = scanEmailDomainLabelEnd(text, index + 1);

    if (labelEnd === null) {
      break;
    }

    index = labelEnd;
  }

  return index;
}

function isUriSchemeCharacter(character: string | undefined): boolean {
  return (
    isAsciiAlphaNumeric(character) ||
    character === "+" ||
    character === "-" ||
    character === "."
  );
}

function parseUriLiteralAutolink(
  text: string,
  startIndex: number,
): ParsedInlineNode | null {
  let scheme: string | null = null;

  if (text.startsWith("http://", startIndex)) {
    scheme = "http://";
  } else if (text.startsWith("https://", startIndex)) {
    scheme = "https://";
  } else if (text.startsWith("ftp://", startIndex)) {
    scheme = "ftp://";
  } else if (text.startsWith("www.", startIndex)) {
    scheme = "www.";
  }

  if (scheme === null || !hasLiteralAutolinkBoundaryBefore(text, startIndex)) {
    return null;
  }

  const value = consumeLiteralAutolink(text, startIndex);

  if (value.length <= scheme.length) {
    return null;
  }

  if (scheme === "www.") {
    const slashIndex = value.indexOf("/");
    const host =
      slashIndex === -1 ? value.slice(4) : value.slice(4, slashIndex);

    if (!isValidWwwAutolinkHost(host)) {
      return null;
    }
  }

  return {
    nextIndex: startIndex + value.length,
    node: createLink(
      [createText(value)],
      normalizeLinkDestination(scheme === "www." ? `http://${value}` : value),
    ),
  };
}

function parseMailLikeLiteralAutolink(
  text: string,
  startIndex: number,
  scheme: "mailto:" | "xmpp:",
): ParsedInlineNode | null {
  if (
    !text.startsWith(scheme, startIndex) ||
    !hasLiteralAutolinkBoundaryBefore(text, startIndex)
  ) {
    return null;
  }

  const emailStartIndex = startIndex + scheme.length;
  const emailEndIndex = scanEmailLiteralEnd(text, emailStartIndex);

  if (emailEndIndex === null) {
    return null;
  }

  let endIndex = emailEndIndex;

  if (scheme === "xmpp:") {
    while (endIndex < text.length) {
      const character = getCharacterAfter(text, endIndex);

      if (
        character === undefined ||
        character === "<" ||
        isWhitespaceCharacter(character)
      ) {
        break;
      }

      if (
        character === "/" &&
        (text.startsWith("mailto:", endIndex + 1) ||
          text.startsWith("xmpp:", endIndex + 1))
      ) {
        break;
      }

      endIndex += character.length;
    }
  }

  const value = trimLiteralAutolinkSuffix(text.slice(startIndex, endIndex));

  return {
    nextIndex: startIndex + value.length,
    node: createLink([createText(value)], normalizeLinkDestination(value)),
  };
}

function parseEmailLiteralAutolink(
  text: string,
  startIndex: number,
): ParsedInlineNode | null {
  if (
    !hasLiteralAutolinkBoundaryBefore(text, startIndex) ||
    !isAsciiAlphaNumeric(text[startIndex])
  ) {
    return null;
  }

  const value = trimLiteralAutolinkSuffix(text.slice(startIndex));
  const emailEndIndex = scanEmailLiteralEnd(value, 0);

  if (emailEndIndex === null) {
    return null;
  }

  const email = value.slice(0, emailEndIndex);

  const nextCharacter = getCharacterAfter(text, startIndex + email.length);

  if (nextCharacter === "-" || nextCharacter === "_") {
    return null;
  }

  return {
    nextIndex: startIndex + email.length,
    node: createLink(
      [createText(email)],
      normalizeLinkDestination(`mailto:${email}`),
    ),
  };
}

function parseAutolinkLiteral(
  text: string,
  startIndex: number,
): ParsedInlineNode | null {
  return (
    parseUriLiteralAutolink(text, startIndex) ??
    parseMailLikeLiteralAutolink(text, startIndex, "mailto:") ??
    parseMailLikeLiteralAutolink(text, startIndex, "xmpp:") ??
    parseEmailLiteralAutolink(text, startIndex)
  );
}

function canStartLiteralAutolink(
  text: string,
  startIndex: number,
  character: string,
  mayContainEmailLiteralAutolink: boolean,
): boolean {
  if (character === "h") {
    if (
      text.startsWith("http://", startIndex) ||
      text.startsWith("https://", startIndex)
    ) {
      return true;
    }
  }

  if (character === "w") {
    if (text.startsWith("www.", startIndex)) {
      return true;
    }
  }

  if (character === "f") {
    if (text.startsWith("ftp://", startIndex)) {
      return true;
    }
  }

  if (character === "m") {
    if (text.startsWith("mailto:", startIndex)) {
      return true;
    }
  }

  if (character === "x") {
    if (text.startsWith("xmpp:", startIndex)) {
      return true;
    }
  }

  if (!mayContainEmailLiteralAutolink) {
    return false;
  }

  let index = startIndex;

  while (index < text.length) {
    const nextCharacter = getCharacterAfter(text, index);

    if (
      nextCharacter === undefined ||
      nextCharacter === "<" ||
      nextCharacter === "[" ||
      nextCharacter === "]" ||
      isWhitespaceCharacter(nextCharacter)
    ) {
      return false;
    }

    if (nextCharacter === "@") {
      return true;
    }

    index += nextCharacter.length;
  }

  return false;
}

function mayContainProtocolLiteralAutolink(text: string): boolean {
  return (
    text.includes("https://") ||
    text.includes("http://") ||
    text.includes("ftp://") ||
    text.includes("www.") ||
    text.includes("mailto:") ||
    text.includes("xmpp:")
  );
}

function canStartProtocolLiteralAutolinkCharacter(character: string): boolean {
  return (
    character === "h" ||
    character === "f" ||
    character === "w" ||
    character === "m" ||
    character === "x"
  );
}

function mayStartLiteralAutolinkAt(
  text: string,
  index: number,
  mayContainProtocolLiteralAutolinkCandidate: boolean,
  mayContainEmailLiteralAutolinkCandidate: boolean,
): boolean {
  const character = text[index] ?? "";

  if (!isAsciiAlphaNumeric(character)) {
    return false;
  }

  if (
    !mayContainEmailLiteralAutolinkCandidate &&
    !(
      mayContainProtocolLiteralAutolinkCandidate &&
      canStartProtocolLiteralAutolinkCharacter(character)
    )
  ) {
    return false;
  }

  if (!hasLiteralAutolinkBoundaryBefore(text, index)) {
    return false;
  }

  return canStartLiteralAutolink(
    text,
    index,
    character,
    mayContainEmailLiteralAutolinkCandidate,
  );
}

function consumePlainInlineTextRun(
  text: string,
  index: number,
  options: InlineParseOptions,
  mayContainProtocolLiteralAutolinkCandidate: boolean,
  mayContainEmailLiteralAutolinkCandidate: boolean,
  allowBracketResolution: boolean,
): number {
  // Batch ordinary prose into larger slices so long messages do not pay for
  // per-character string concatenation in the hot inline scan loop.
  let nextIndex = index;

  while (nextIndex < text.length) {
    const character = text[nextIndex] ?? "";
    const nextCharacter = text[nextIndex + 1];

    if (
      character === "\n" ||
      character === "\r" ||
      character === "\\" ||
      character === "`" ||
      character === "<" ||
      character === "&" ||
      character === "]" ||
      character === "*" ||
      character === "_" ||
      (options.mathExtensions && character === "$") ||
      (options.gfmExtensions && character === "~") ||
      (character === "[" &&
        ((allowBracketResolution && options.allowLinks) ||
          (!allowBracketResolution &&
            (options.allowLinks ||
              options.allowImages ||
              options.gfmExtensions)))) ||
      (character === "!" && nextCharacter === "[")
    ) {
      return nextIndex;
    }

    if (mayContainEmailLiteralAutolinkCandidate) {
      if (mayStartLiteralAutolinkAt(text, nextIndex, false, true)) {
        return nextIndex;
      }
    } else if (
      mayContainProtocolLiteralAutolinkCandidate &&
      canStartProtocolLiteralAutolinkCharacter(character)
    ) {
      if (mayStartLiteralAutolinkAt(text, nextIndex, true, false)) {
        return nextIndex;
      }
    }

    nextIndex += 1;
  }

  return nextIndex;
}

function mayContainGfmLiteralAutolink(text: string): boolean {
  return mayContainProtocolLiteralAutolink(text) || text.includes("@");
}

function hasPotentialLiteralAutolinkTailToEnd(
  text: string,
  startIndex: number,
): boolean {
  if (startIndex >= text.length) {
    return false;
  }

  for (let index = startIndex; index < text.length; index += 1) {
    const character = getCharacterAfter(text, index);

    if (
      character === undefined ||
      character === "<" ||
      character === "[" ||
      character === "]" ||
      isWhitespaceCharacter(character)
    ) {
      return false;
    }
  }

  return true;
}

function finalizeInlineChildren(
  children: readonly PhrasingContent[],
): PhrasingContent[] {
  return children as PhrasingContent[];
}

function flagOptimisticInlineChildren(
  children: readonly PhrasingContent[],
): PhrasingContent[] {
  for (let index = 0; index < children.length; index += 1) {
    const child = children[index];

    if (child?.type === "text" || child?.type === "break") {
      continue;
    }

    const flaggedChildren = children.slice(0, index);

    for (
      let childIndex = index;
      childIndex < children.length;
      childIndex += 1
    ) {
      const nextChild = children[childIndex];

      if (nextChild === undefined) {
        continue;
      }

      flaggedChildren.push(
        nextChild.type === "text" || nextChild.type === "break"
          ? nextChild
          : withInlineFlags(nextChild, OPTIMISTIC_INLINE_FLAGS),
      );
    }

    return flaggedChildren;
  }

  return children as PhrasingContent[];
}

function arePhrasingChildrenEqual(
  left: readonly PhrasingContent[],
  right: readonly PhrasingContent[],
): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    const leftChild = left[index];
    const rightChild = right[index];

    if (leftChild === undefined || rightChild === undefined) {
      return false;
    }

    if (!arePhrasingNodesEqual(leftChild, rightChild)) {
      return false;
    }
  }

  return true;
}

function arePhrasingNodesEqual(
  left: PhrasingContent,
  right: PhrasingContent,
): boolean {
  if (left.type !== right.type) {
    return false;
  }

  const leftRecord = left as unknown as Record<string, unknown>;
  const rightRecord = right as unknown as Record<string, unknown>;

  for (const field of ["value", "url", "title", "alt", "identifier", "label"]) {
    if (leftRecord[field] !== rightRecord[field]) {
      return false;
    }
  }

  const leftChildren = leftRecord.children;
  const rightChildren = rightRecord.children;

  if (!Array.isArray(leftChildren) && !Array.isArray(rightChildren)) {
    return true;
  }

  if (!Array.isArray(leftChildren) || !Array.isArray(rightChildren)) {
    return false;
  }

  return arePhrasingChildrenEqual(
    leftChildren as readonly PhrasingContent[],
    rightChildren as readonly PhrasingContent[],
  );
}

export function findReferenceDefinition(
  definitions: readonly InternalLinkReferenceDefinition[],
  label: string,
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
): InternalLinkReferenceDefinition | null {
  const normalizedLabel = normalizeReferenceLabel(label);

  if (normalizedLabel.length === 0) {
    return null;
  }

  const indexedDefinition = definitionIndex?.get(normalizedLabel);

  if (indexedDefinition !== undefined) {
    return indexedDefinition;
  }

  for (const definition of definitions) {
    if (definition.normalizedLabel === normalizedLabel) {
      return definition;
    }
  }

  return null;
}

function parseFootnoteReferenceInline(
  text: string,
  startIndex: number,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
): ParsedInlineNode | null {
  if (
    (text[startIndex] ?? "") !== "[" ||
    (text[startIndex + 1] ?? "") !== "^"
  ) {
    return null;
  }

  const labelEndIndex = text.indexOf("]", startIndex + 2);

  if (labelEndIndex === -1) {
    return null;
  }

  const label = text.slice(startIndex + 2, labelEndIndex);

  const definition = findFootnoteDefinition(
    footnoteDefinitions,
    label,
    footnoteDefinitionIndex,
  );

  if (definition === null) {
    return null;
  }

  return {
    nextIndex: labelEndIndex + 1,
    node: createFootnoteReference(definition.normalizedLabel, definition.label),
  };
}

export function findFootnoteDefinition(
  definitions: readonly InternalFootnoteReferenceDefinition[],
  label: string,
  definitionIndex?: ReadonlyMap<string, InternalFootnoteReferenceDefinition>,
): InternalFootnoteReferenceDefinition | null {
  const identifier = normalizeReferenceLabel(label);

  if (identifier.length === 0) {
    return null;
  }

  const indexedDefinition = definitionIndex?.get(identifier);

  if (indexedDefinition !== undefined) {
    return indexedDefinition;
  }

  for (const definition of definitions) {
    if (definition.normalizedLabel === identifier) {
      return definition;
    }
  }

  return null;
}

function getEarlierStart(
  currentStart: number | undefined,
  nextStart: number | undefined,
): number | undefined {
  if (nextStart === undefined) {
    return currentStart;
  }

  if (currentStart === undefined || nextStart < currentStart) {
    return nextStart;
  }

  return currentStart;
}

function isAsciiDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return code >= 0x30 && code <= 0x39;
}

function isAsciiHexDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x46) ||
    (code >= 0x61 && code <= 0x66)
  );
}

function isEmailLocalPartCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  return (
    isAsciiAlphaNumeric(character) ||
    character === "." ||
    character === "!" ||
    character === "#" ||
    character === "$" ||
    character === "%" ||
    character === "&" ||
    character === "'" ||
    character === "*" ||
    character === "+" ||
    character === "/" ||
    character === "=" ||
    character === "?" ||
    character === "^" ||
    character === "_" ||
    character === "`" ||
    character === "{" ||
    character === "|" ||
    character === "}" ||
    character === "~" ||
    character === "-"
  );
}

function isEmailDomainCharacter(character: string | undefined): boolean {
  return (
    isAsciiAlphaNumeric(character) || character === "-" || character === "."
  );
}

function isLiteralAutolinkTerminator(character: string | undefined): boolean {
  return (
    character === undefined ||
    character === "<" ||
    character === "[" ||
    character === "]" ||
    isWhitespaceCharacter(character)
  );
}

function findTrailingPotentialCharacterReferenceStart(
  text: string,
  startIndex: number,
): number | undefined {
  const index = text.lastIndexOf("&");

  if (index < startIndex) {
    return undefined;
  }

  let nextIndex = index + 1;

  if (nextIndex === text.length) {
    return index;
  }

  if (text[nextIndex] === "#") {
    nextIndex += 1;

    if (nextIndex === text.length) {
      return index;
    }

    if (text[nextIndex] === "x" || text[nextIndex] === "X") {
      nextIndex += 1;

      if (nextIndex === text.length) {
        return index;
      }

      let digitCount = 0;

      while (nextIndex < text.length && isAsciiHexDigit(text[nextIndex])) {
        digitCount += 1;
        nextIndex += 1;
      }

      return digitCount > 0 && digitCount <= 6 && nextIndex === text.length
        ? index
        : undefined;
    }

    let digitCount = 0;

    while (nextIndex < text.length && isAsciiDigit(text[nextIndex])) {
      digitCount += 1;
      nextIndex += 1;
    }

    return digitCount > 0 && digitCount <= 7 && nextIndex === text.length
      ? index
      : undefined;
  }

  if (!isAsciiLetter(text[nextIndex])) {
    return undefined;
  }

  let nameLength = 1;
  nextIndex += 1;

  while (nextIndex < text.length && isAsciiAlphaNumeric(text[nextIndex])) {
    nameLength += 1;

    if (nameLength > 32) {
      break;
    }

    nextIndex += 1;
  }

  return nameLength <= 32 && nextIndex === text.length ? index : undefined;
}

function isPotentialUriLiteralAutolinkPrefix(
  text: string,
  startIndex: number,
  endIndex: number,
): boolean {
  for (const scheme of SUPPORTED_LITERAL_AUTOLINK_SCHEMES) {
    const candidateLength = endIndex - startIndex;
    const prefixLength = Math.min(candidateLength, scheme.length);
    let index = 0;

    while (index < prefixLength && text[startIndex + index] === scheme[index]) {
      index += 1;
    }

    if (index !== prefixLength) {
      continue;
    }

    if (candidateLength <= scheme.length) {
      return true;
    }

    for (let suffixIndex = scheme.length; suffixIndex < candidateLength; ) {
      const character = getCharacterAfter(text, startIndex + suffixIndex);

      if (character === undefined) {
        break;
      }

      if (isLiteralAutolinkTerminator(character)) {
        return false;
      }

      suffixIndex += character.length;
    }

    return true;
  }

  return false;
}

function isPotentialEmailLiteralPrefix(
  text: string,
  startIndex: number,
  endIndex: number,
): boolean {
  if (startIndex >= endIndex) {
    return false;
  }

  let index = startIndex;

  while (index < endIndex && isEmailLocalPartCharacter(text[index])) {
    index += 1;
  }

  if (index === startIndex) {
    return false;
  }

  if (index === endIndex) {
    return true;
  }

  if (text[index] !== "@") {
    return false;
  }

  index += 1;

  if (index === endIndex) {
    return true;
  }

  let segmentLength = 0;

  while (index < endIndex) {
    const character = text[index];

    if (character === ".") {
      if (segmentLength === 0) {
        return false;
      }

      segmentLength = 0;
      index += 1;
      continue;
    }

    if (!isEmailDomainCharacter(character)) {
      return false;
    }

    if (character === "-" && segmentLength === 0) {
      return false;
    }

    segmentLength += 1;
    index += 1;
  }

  return segmentLength > 0 || text[endIndex - 1] === ".";
}

function findTrailingLiteralAutolinkSegmentStart(
  text: string,
  startIndex: number,
  endIndex = text.length,
): number {
  let segmentStart = endIndex;

  while (segmentStart > startIndex) {
    const previousCharacter = getCharacterBefore(text, segmentStart);

    if (
      previousCharacter === undefined ||
      isLiteralAutolinkTerminator(previousCharacter)
    ) {
      break;
    }

    segmentStart -= previousCharacter.length;
  }

  return segmentStart;
}

function findTrailingLiteralAutolinkCandidateStart(
  text: string,
  startIndex: number,
): number | undefined {
  const searchStart = Math.max(
    startIndex,
    findTrailingLiteralAutolinkSegmentStart(text, startIndex),
  );

  for (let index = searchStart; index < text.length; index += 1) {
    const character = text[index];

    if (!isAsciiAlphaNumeric(character)) {
      continue;
    }

    if (!hasLiteralAutolinkBoundaryBefore(text, index)) {
      continue;
    }

    if (
      isPotentialUriLiteralAutolinkPrefix(text, index, text.length) ||
      isPotentialEmailLiteralPrefix(text, index, text.length)
    ) {
      return index;
    }
  }

  return undefined;
}

function findTrailingPlainAppendSensitiveStart(
  text: string,
  bufferStartIndex: number | undefined,
  buffer: string,
  options: InlineParseOptions,
): number | undefined {
  if (buffer.length === 0 || bufferStartIndex === undefined) {
    return undefined;
  }

  let appendSensitiveStart: number | undefined;

  appendSensitiveStart = getEarlierStart(
    appendSensitiveStart,
    findTrailingPotentialCharacterReferenceStart(text, bufferStartIndex),
  );

  if (
    options.allowImages &&
    buffer.endsWith("!") &&
    (buffer.length === 1 || buffer[buffer.length - 2] !== "\\")
  ) {
    appendSensitiveStart = getEarlierStart(
      appendSensitiveStart,
      text.length - 1,
    );
  }

  return appendSensitiveStart;
}

function getInlineAppendSafeOffset(
  text: string,
  unresolvedStart: number | undefined,
  appendSensitiveStart: number | undefined,
): number {
  return getEarlierStart(unresolvedStart, appendSensitiveStart) ?? text.length;
}

function getEarliestUnresolvedDelimiterStart(
  lastDelimiter: MutableDelimiterEntry | null,
): number | undefined {
  let earliestStart: number | undefined;
  let current = lastDelimiter;

  while (current !== null) {
    earliestStart = getEarlierStart(earliestStart, current.startIndex);
    current = current.previous;
  }

  return earliestStart;
}

function getEarliestUnresolvedBracketStart(
  lastBracket: MutableBracketEntry | null,
): number | undefined {
  let earliestStart: number | undefined;
  let current = lastBracket;

  while (current !== null) {
    earliestStart = getEarlierStart(
      earliestStart,
      getBracketSyntaxStart(current),
    );
    current = current.previous;
  }

  return earliestStart;
}

function readLine(source: string, startOffset: number): Line {
  let endOffset = startOffset;

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

  return {
    startOffset,
    endOffset,
    nextOffset,
    hasLineBreak: nextOffset > endOffset,
    text: source.slice(startOffset, endOffset),
  };
}

function normalizeCodeSpanValue(value: string): string {
  let collapsed = "";
  let hasNonSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (character === "\r") {
      collapsed += " ";

      if ((value[index + 1] ?? "") === "\n") {
        index += 1;
      }

      continue;
    }

    if (character === "\n") {
      collapsed += " ";
      continue;
    }

    if (character !== " ") {
      hasNonSpace = true;
    }

    collapsed += character;
  }

  if (
    collapsed.length >= 2 &&
    collapsed.startsWith(" ") &&
    collapsed.endsWith(" ") &&
    hasNonSpace
  ) {
    return collapsed.slice(1, -1);
  }

  return collapsed;
}

function parseCodeSpan(text: string, startIndex: number): CodeSpan | null {
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
      return {
        nextIndex: closerEnd,
        value: normalizeCodeSpanValue(text.slice(openerEnd, searchIndex)),
      };
    }

    searchIndex = closerEnd;
  }

  return null;
}

function countBackticks(text: string, startIndex: number): number {
  let index = startIndex;

  while (text[index] === "`") {
    index += 1;
  }

  return index - startIndex;
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

function getCharacterStartBefore(text: string, endIndex: number): number {
  if (endIndex <= 0) {
    return 0;
  }

  const lastCodeUnit = text.charCodeAt(endIndex - 1);

  if (
    (lastCodeUnit & 0xfc00) === 0xdc00 &&
    endIndex >= 2 &&
    (text.charCodeAt(endIndex - 2) & 0xfc00) === 0xd800
  ) {
    return endIndex - 2;
  }

  return endIndex - 1;
}

function getDelimiterAppendSensitiveStart(
  text: string,
  startIndex: number,
): number {
  let appendSensitiveStart = getCharacterStartBefore(text, startIndex);

  while (appendSensitiveStart > 0 && text[appendSensitiveStart - 1] === "\\") {
    appendSensitiveStart -= 1;
  }

  return appendSensitiveStart;
}

function appendInlineToken(events: InlineEvent[], token: InlineEvent): void {
  if (token.kind === "text") {
    appendInlineEvent(events, token.value);
    return;
  }

  events.push(token);
}

function extractPlainText(children: readonly PhrasingContent[]): string {
  let value = "";

  for (const child of children) {
    switch (child.type) {
      case "break":
        value += "\n";
        break;
      case "emphasis":
      case "link":
      case "strong":
        value += extractPlainText(child.children);
        break;
      case "image":
        value += child.alt ?? "";
        break;
      case "inlineCode":
      case "text":
        value += child.value;
        break;
      default:
        break;
    }
  }

  return value;
}

function containsAngleAutolinkDisallowedCharacter(value: string): boolean {
  for (const character of value) {
    if (character === "<" || character === ">") {
      return true;
    }

    if (character <= " ") {
      return true;
    }
  }

  return false;
}

function isUriAutolink(value: string): boolean {
  if (!isAsciiLetter(value[0])) {
    return false;
  }

  let index = 1;

  while (index < value.length && isUriSchemeCharacter(value[index])) {
    index += 1;

    if (index > 32) {
      return false;
    }
  }

  if (index < 2 || value[index] !== ":") {
    return false;
  }

  return !containsAngleAutolinkDisallowedCharacter(value);
}

function isEmailAutolink(value: string): boolean {
  return scanEmailLiteralEnd(value, 0) === value.length;
}

function parseAutolinkInline(
  text: string,
  startIndex: number,
): ParsedInlineNode | null {
  if ((text[startIndex] ?? "") !== "<") {
    return null;
  }

  const endIndex = text.indexOf(">", startIndex + 1);

  if (endIndex === -1) {
    return null;
  }

  const value = text.slice(startIndex + 1, endIndex);

  if (containsAngleAutolinkDisallowedCharacter(value)) {
    return null;
  }

  if (isUriAutolink(value)) {
    return {
      nextIndex: endIndex + 1,
      node: createLink([createText(value)], normalizeLinkDestination(value)),
    };
  }

  if (isEmailAutolink(value)) {
    return {
      nextIndex: endIndex + 1,
      node: createLink(
        [createText(value)],
        normalizeLinkDestination(`mailto:${value}`),
      ),
    };
  }

  return null;
}

export function parseHtmlInline(
  text: string,
  startIndex: number,
): ParsedInlineNode | null {
  if ((text[startIndex] ?? "") !== "<") {
    return null;
  }

  if (text.startsWith("<!--->", startIndex)) {
    return {
      nextIndex: startIndex + "<!--->".length,
      node: createHtml("<!--->"),
    };
  }

  if (text.startsWith("<!-->", startIndex)) {
    return {
      nextIndex: startIndex + "<!-->".length,
      node: createHtml("<!-->"),
    };
  }

  if (text.startsWith("<!--", startIndex)) {
    const endIndex = text.indexOf("-->", startIndex + 4);

    return endIndex === -1
      ? null
      : {
          nextIndex: endIndex + 3,
          node: createHtml(text.slice(startIndex, endIndex + 3)),
        };
  }

  if (text.startsWith("<?", startIndex)) {
    const endIndex = text.indexOf("?>", startIndex + 2);

    return endIndex === -1
      ? null
      : {
          nextIndex: endIndex + 2,
          node: createHtml(text.slice(startIndex, endIndex + 2)),
        };
  }

  if (text.startsWith("<![CDATA[", startIndex)) {
    const endIndex = text.indexOf("]]>", startIndex + 9);

    return endIndex === -1
      ? null
      : {
          nextIndex: endIndex + 3,
          node: createHtml(text.slice(startIndex, endIndex + 3)),
        };
  }

  if (text.startsWith("</", startIndex)) {
    const endIndex = scanCompleteClosingHtmlTag(text, startIndex);

    if (endIndex === null) {
      return null;
    }

    return {
      nextIndex: endIndex,
      node: createHtml(text.slice(startIndex, endIndex)),
    };
  }

  if (text.startsWith("<!", startIndex)) {
    if (!isHtmlDeclarationStart(text, startIndex)) {
      return null;
    }

    const endIndex = text.indexOf(">", startIndex + 2);

    return endIndex === -1
      ? null
      : {
          nextIndex: endIndex + 1,
          node: createHtml(text.slice(startIndex, endIndex + 1)),
        };
  }

  if (!isAsciiLetter(text[startIndex + 1])) {
    return null;
  }

  const endIndex = scanCompleteOpeningHtmlTag(text, startIndex);

  if (endIndex === null) {
    return null;
  }

  return {
    nextIndex: endIndex,
    node: createHtml(text.slice(startIndex, endIndex)),
  };
}

function parseAngleInline(
  text: string,
  startIndex: number,
): ParsedInlineNode | null {
  return (
    parseAutolinkInline(text, startIndex) ?? parseHtmlInline(text, startIndex)
  );
}

function findLinkLabelEnd(text: string, startIndex: number): number | null {
  let depth = 0;
  let index = startIndex;

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character === "\\") {
      index += text[index + 1] === undefined ? 1 : 2;
      continue;
    }

    if (character === "`") {
      const codeSpan = parseCodeSpan(text, index);

      if (codeSpan !== null) {
        index = codeSpan.nextIndex;
        continue;
      }

      index += countBackticks(text, index);
      continue;
    }

    if (character === "<") {
      const parsedAngleNode = parseAngleInline(text, index);

      if (parsedAngleNode !== null) {
        index = parsedAngleNode.nextIndex;
        continue;
      }
    }

    if (character === "[") {
      depth += 1;
      index += 1;
      continue;
    }

    if (character === "]") {
      if (depth === 0) {
        return index;
      }

      depth -= 1;
      index += 1;
      continue;
    }

    index += 1;
  }

  return null;
}

function skipLinkWhitespace(text: string, startIndex: number): number {
  let index = startIndex;

  while (isLinkWhitespaceCharacter(text[index])) {
    index += 1;
  }

  return index;
}

function parseLinkTitle(
  text: string,
  startIndex: number,
): { readonly nextIndex: number; readonly value: string } | null {
  const opener = text[startIndex];

  if (opener !== '"' && opener !== "'" && opener !== "(") {
    return null;
  }

  const closer = opener === "(" ? ")" : opener;
  let index = startIndex + 1;
  let value = "";

  while (index < text.length) {
    const character = text[index] ?? "";
    const nextCharacter = text[index + 1];

    if (character === "\\") {
      if (
        nextCharacter !== undefined &&
        isEscapablePunctuation(nextCharacter)
      ) {
        value += nextCharacter;
        index += 2;
        continue;
      }

      value += character;
      index += 1;
      continue;
    }

    if (character === "&") {
      const entityMatch = matchCharacterReference(text, index);

      if (entityMatch !== null) {
        value += decodeCharacterReferences(entityMatch);
        index += entityMatch.length;
        continue;
      }
    }

    if (character === closer) {
      return {
        nextIndex: index + 1,
        value,
      };
    }

    value += character;
    index += 1;
  }

  return null;
}

function parseInlineLinkDestination(
  text: string,
  startIndex: number,
): ParsedLinkDestination | null {
  let index = skipLinkWhitespace(text, startIndex);
  let url = "";

  if ((text[index] ?? "") === ")") {
    return {
      nextIndex: index + 1,
      url: "",
    };
  }

  if ((text[index] ?? "") === "<") {
    index += 1;

    while (index < text.length) {
      const character = text[index] ?? "";
      const nextCharacter = text[index + 1];

      if (character === "\n" || character === "\r") {
        return null;
      }

      if (character === "\\") {
        if (
          nextCharacter !== undefined &&
          isEscapablePunctuation(nextCharacter)
        ) {
          url += nextCharacter;
          index += 2;
          continue;
        }

        url += character;
        index += 1;
        continue;
      }

      if (character === "&") {
        const entityMatch = matchCharacterReference(text, index);

        if (entityMatch !== null) {
          url += decodeCharacterReferences(entityMatch);
          index += entityMatch.length;
          continue;
        }
      }

      if (character === ">") {
        index += 1;
        break;
      }

      url += character;
      index += 1;
    }

    if ((text[index - 1] ?? "") !== ">") {
      return null;
    }
  } else {
    let parenthesisDepth = 0;

    while (index < text.length) {
      const character = text[index] ?? "";
      const nextCharacter = text[index + 1];

      if (character === "\\") {
        if (
          nextCharacter !== undefined &&
          isEscapablePunctuation(nextCharacter)
        ) {
          url += nextCharacter;
          index += 2;
          continue;
        }

        url += character;
        index += 1;
        continue;
      }

      if (character === "&") {
        const entityMatch = matchCharacterReference(text, index);

        if (entityMatch !== null) {
          url += decodeCharacterReferences(entityMatch);
          index += entityMatch.length;
          continue;
        }
      }

      if (isLinkWhitespaceCharacter(character)) {
        break;
      }

      if (character === "(") {
        parenthesisDepth += 1;
        url += character;
        index += 1;
        continue;
      }

      if (character === ")") {
        if (parenthesisDepth === 0) {
          break;
        }

        parenthesisDepth -= 1;
        url += character;
        index += 1;
        continue;
      }

      url += character;
      index += 1;
    }
  }

  index = skipLinkWhitespace(text, index);

  let title: string | undefined;
  const parsedTitle = parseLinkTitle(text, index);

  if (parsedTitle !== null) {
    title = parsedTitle.value;
    index = skipLinkWhitespace(text, parsedTitle.nextIndex);
  }

  if ((text[index] ?? "") !== ")") {
    return null;
  }

  return {
    nextIndex: index + 1,
    title,
    url: normalizeLinkDestination(url),
  };
}

function parseLinkOrImageInline(
  text: string,
  startIndex: number,
  options: InlineParseOptions,
): ParsedInlineNode | null {
  const isImage =
    (text[startIndex] ?? "") === "!" && (text[startIndex + 1] ?? "") === "[";
  const isLink = (text[startIndex] ?? "") === "[";

  if (isImage ? !options.allowImages : !isLink || !options.allowLinks) {
    return null;
  }

  const labelStartIndex = startIndex + (isImage ? 2 : 1);
  const labelEndIndex = findLinkLabelEnd(text, labelStartIndex);

  if (labelEndIndex === null || (text[labelEndIndex + 1] ?? "") !== "(") {
    return null;
  }

  const destination = parseInlineLinkDestination(text, labelEndIndex + 2);

  if (destination === null) {
    return null;
  }

  const label = text.slice(labelStartIndex, labelEndIndex);
  const labelChildren = createInlineChildren(label, {
    allowImages: true,
    allowLinks: isImage,
    gfmExtensions: options.gfmExtensions,
    mathExtensions: options.mathExtensions,
  });

  return {
    nextIndex: destination.nextIndex,
    node: isImage
      ? createImage(
          destination.url,
          extractPlainText(labelChildren),
          destination.title,
        )
      : createLink(labelChildren, destination.url, destination.title),
  };
}

function parseReferenceLabelToken(
  text: string,
  startIndex: number,
): { readonly label: string; readonly nextIndex: number } | null {
  if (text[startIndex] !== "[") {
    return null;
  }

  let index = startIndex + 1;
  let contentLength = 0;

  while (index < text.length) {
    const character = text[index] ?? "";

    if (character === "]") {
      return {
        label: text.slice(startIndex + 1, index),
        nextIndex: index + 1,
      };
    }

    if (contentLength >= 1000 || character === "[") {
      return null;
    }

    if (character === "\\") {
      if (text[index + 1] === undefined) {
        return null;
      }

      index += 2;
      contentLength += 1;
      continue;
    }

    index += 1;
    contentLength += 1;
  }

  return null;
}

function skipAsciiWhitespace(text: string, startIndex: number): number {
  let index = startIndex;

  while (isAsciiWhitespace(text[index])) {
    index += 1;
  }

  return index;
}

function skipLinkSpaceAndSingleLineEnding(
  text: string,
  startIndex: number,
): number {
  let index = skipAsciiWhitespace(text, startIndex);

  if (text[index] === "\r") {
    index += text[index + 1] === "\n" ? 2 : 1;
    return skipAsciiWhitespace(text, index);
  }

  if (text[index] === "\n") {
    return skipAsciiWhitespace(text, index + 1);
  }

  return index;
}

function isAtReferenceDefinitionLineEnd(
  text: string,
  startIndex: number,
): boolean {
  const index = skipAsciiWhitespace(text, startIndex);
  const character = text[index];

  return character === undefined || character === "\n" || character === "\r";
}

function parseReferenceDestination(
  text: string,
  startIndex: number,
): { readonly nextIndex: number; readonly url: string } | null {
  let index = startIndex;
  let url = "";

  if (text[index] === "<") {
    index += 1;

    while (index < text.length) {
      const character = text[index] ?? "";
      const nextCharacter = text[index + 1];

      if (character === "\n" || character === "\r") {
        return null;
      }

      if (character === "\\") {
        if (
          nextCharacter !== undefined &&
          isEscapablePunctuation(nextCharacter)
        ) {
          url += nextCharacter;
          index += 2;
          continue;
        }

        url += character;
        index += 1;
        continue;
      }

      if (character === "&") {
        const entityMatch = matchCharacterReference(text, index);

        if (entityMatch !== null) {
          url += decodeCharacterReferences(entityMatch);
          index += entityMatch.length;
          continue;
        }
      }

      if (character === ">") {
        return {
          nextIndex: index + 1,
          url: normalizeLinkDestination(url),
        };
      }

      url += character;
      index += 1;
    }

    return null;
  }

  let parenthesisDepth = 0;

  while (index < text.length) {
    const character = text[index] ?? "";
    const nextCharacter = text[index + 1];

    if (character === "\n" || character === "\r") {
      break;
    }

    if (character === "\\") {
      if (
        nextCharacter !== undefined &&
        isEscapablePunctuation(nextCharacter)
      ) {
        url += nextCharacter;
        index += 2;
        continue;
      }

      url += character;
      index += 1;
      continue;
    }

    if (character === "&") {
      const entityMatch = matchCharacterReference(text, index);

      if (entityMatch !== null) {
        url += decodeCharacterReferences(entityMatch);
        index += entityMatch.length;
        continue;
      }
    }

    if (isAsciiWhitespace(character)) {
      break;
    }

    if (character === "(") {
      parenthesisDepth += 1;
      url += character;
      index += 1;
      continue;
    }

    if (character === ")") {
      if (parenthesisDepth === 0) {
        break;
      }

      parenthesisDepth -= 1;
      url += character;
      index += 1;
      continue;
    }

    url += character;
    index += 1;
  }

  return url.length === 0
    ? null
    : {
        nextIndex: index,
        url: normalizeLinkDestination(url),
      };
}

function parseLinkReferenceDefinition(
  source: string,
  startOffset: number,
): {
  readonly definition: InternalLinkReferenceDefinition;
  readonly nextOffset: number;
} | null {
  const line = readLine(source, startOffset);
  let indent = 0;

  while (indent < line.text.length && line.text[indent] === " ") {
    indent += 1;
  }

  if (indent > 3) {
    return null;
  }

  if (line.text[indent] !== "[") {
    return null;
  }

  const labelStartIndex = startOffset + indent;
  const label = parseReferenceLabelToken(source, labelStartIndex);

  if (label === null || source[label.nextIndex] !== ":") {
    return null;
  }

  let index = skipLinkSpaceAndSingleLineEnding(source, label.nextIndex + 1);
  const destination = parseReferenceDestination(source, index);

  if (destination === null) {
    return null;
  }

  const destinationEndIndex = destination.nextIndex;
  index = skipLinkSpaceAndSingleLineEnding(source, destinationEndIndex);
  const titleStartsOnNextLine = containsLineEnding(
    source,
    destinationEndIndex,
    index,
  );

  let title: string | undefined;

  if (index !== destinationEndIndex) {
    const parsedTitle = parseLinkTitle(source, index);

    if (parsedTitle !== null) {
      if (containsBlankLine(parsedTitle.value)) {
        return null;
      }

      if (isAtReferenceDefinitionLineEnd(source, parsedTitle.nextIndex)) {
        title = parsedTitle.value;
        index = parsedTitle.nextIndex;
      } else if (!titleStartsOnNextLine) {
        return null;
      } else {
        index = destinationEndIndex;
      }
    } else if (!isAtReferenceDefinitionLineEnd(source, destinationEndIndex)) {
      return null;
    } else {
      index = destinationEndIndex;
    }
  } else if (!isAtReferenceDefinitionLineEnd(source, destinationEndIndex)) {
    return null;
  }

  index = skipAsciiWhitespace(source, index);

  if (source[index] === "\r") {
    index += source[index + 1] === "\n" ? 2 : 1;
  } else if (source[index] === "\n") {
    index += 1;
  }

  const normalizedLabel = normalizeReferenceLabel(label.label);

  if (normalizedLabel.length === 0) {
    return null;
  }

  return {
    definition: {
      normalizedLabel,
      startOffset,
      title,
      url: destination.url,
    },
    nextOffset: index,
  };
}

export function parseLinkReferenceDefinitions(
  source: string,
  startOffset: number,
): {
  readonly definitions: readonly InternalLinkReferenceDefinition[];
  readonly nextOffset: number;
} | null {
  const definitions: InternalLinkReferenceDefinition[] = [];
  let offset = startOffset;

  while (offset < source.length) {
    const parsedDefinition = parseLinkReferenceDefinition(source, offset);

    if (parsedDefinition === null) {
      break;
    }

    if (
      findReferenceDefinition(
        definitions,
        parsedDefinition.definition.normalizedLabel,
        undefined,
      ) === null
    ) {
      definitions.push(parsedDefinition.definition);
    }

    offset = parsedDefinition.nextOffset;
  }

  return definitions.length === 0
    ? null
    : {
        definitions,
        nextOffset: offset,
      };
}

function scanInline(
  text: string,
  options: InlineParseOptions,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
  handlers: InlineScannerHandlers,
  allowBracketResolution: boolean,
  startIndex = 0,
): ScannedInlineState {
  let buffer = "";
  let bufferStartIndex: number | undefined;
  let bufferTrailingWhitespaceStartIndex: number | undefined;
  let index = startIndex;
  let appendSensitiveStart: number | undefined;
  let unresolvedStart: number | undefined;
  const mayContainProtocolLiteralAutolinkCandidate =
    options.gfmExtensions &&
    options.allowLinks &&
    mayContainProtocolLiteralAutolink(text);
  const mayContainEmailLiteralAutolinkCandidate =
    options.gfmExtensions && options.allowLinks && text.includes("@");

  function flushBuffer(): void {
    if (buffer.length === 0) {
      return;
    }

    handlers.appendText(buffer);
    buffer = "";
    bufferStartIndex = undefined;
    bufferTrailingWhitespaceStartIndex = undefined;
  }

  function appendToBuffer(
    value: string,
    startOffset: number,
    sourceLength = value.length,
  ): void {
    if (value.length === 0) {
      return;
    }

    const previousBufferLength = buffer.length;

    if (buffer.length === 0) {
      bufferStartIndex = startOffset;
      buffer = value;
    } else {
      buffer += value;
    }

    const trailingWhitespaceLength = countTrailingInlineWhitespace(value);

    if (trailingWhitespaceLength === 0) {
      bufferTrailingWhitespaceStartIndex = undefined;
      return;
    }

    if (trailingWhitespaceLength === value.length) {
      if (
        previousBufferLength === 0 ||
        bufferTrailingWhitespaceStartIndex === undefined
      ) {
        bufferTrailingWhitespaceStartIndex = startOffset;
      }

      return;
    }

    bufferTrailingWhitespaceStartIndex =
      sourceLength === value.length
        ? startOffset + (value.length - trailingWhitespaceLength)
        : startOffset;
  }

  while (index < text.length) {
    const character = text[index] ?? "";
    const nextCharacter = text[index + 1];

    if (options.mathExtensions && text.startsWith("\\(", index)) {
      const inlineMath = parseParenthesizedInlineMath(text, index);

      if (inlineMath !== null) {
        flushBuffer();
        handlers.appendNode(inlineMath.node);
        index = inlineMath.nextIndex;
        continue;
      }

      unresolvedStart = getEarlierStart(unresolvedStart, index);
      appendToBuffer("\\(", index);
      index += 2;
      continue;
    }

    if (character === "\\") {
      if (nextCharacter === "\n") {
        flushBuffer();
        handlers.appendNode(createHardBreak());
        index += 2;
        continue;
      }

      if (
        nextCharacter !== undefined &&
        isEscapablePunctuation(nextCharacter)
      ) {
        flushBuffer();
        handlers.appendText(nextCharacter);
        index += 2;
        continue;
      }

      if (nextCharacter === undefined) {
        unresolvedStart = getEarlierStart(unresolvedStart, index);
      }

      appendToBuffer(character, index);
      index += 1;
      continue;
    }

    if (character === "`") {
      const codeSpan = parseCodeSpan(text, index);

      if (codeSpan !== null) {
        if (codeSpan.nextIndex === text.length) {
          appendSensitiveStart = getEarlierStart(appendSensitiveStart, index);
        }

        flushBuffer();
        handlers.appendNode(createInlineCode(codeSpan.value));
        index = codeSpan.nextIndex;
        continue;
      }

      const backtickCount = countBackticks(text, index);

      unresolvedStart = getEarlierStart(unresolvedStart, index);
      appendToBuffer("`".repeat(backtickCount), index);
      index += backtickCount;
      continue;
    }

    if (character === "<") {
      const parsedAngleNode = parseAngleInline(text, index);

      if (parsedAngleNode !== null) {
        flushBuffer();
        handlers.appendNode(parsedAngleNode.node);
        index = parsedAngleNode.nextIndex;
        continue;
      }

      unresolvedStart = getEarlierStart(unresolvedStart, index);
    }

    if (character === "&") {
      const entityMatch = matchCharacterReference(text, index);

      if (entityMatch !== null) {
        appendToBuffer(
          decodeCharacterReferences(entityMatch),
          index,
          entityMatch.length,
        );
        index += entityMatch.length;
        continue;
      }
    }

    if (options.mathExtensions && character === "$") {
      const inlineMath = parseDollarInlineMath(text, index);

      if (inlineMath !== "literal" && inlineMath !== "unresolved") {
        flushBuffer();
        handlers.appendNode(inlineMath.node);
        index = inlineMath.nextIndex;
        continue;
      }

      if (inlineMath === "unresolved") {
        unresolvedStart = getEarlierStart(unresolvedStart, index);
      }
    }

    if (
      character === "!" &&
      nextCharacter === "[" &&
      (text[index + 2] ?? "") === "^"
    ) {
      appendToBuffer("!", index);
      index += 1;
      continue;
    }

    if (character === "[" && nextCharacter === "^") {
      if (options.gfmExtensions) {
        const footnoteReference = parseFootnoteReferenceInline(
          text,
          index,
          footnoteDefinitions,
          footnoteDefinitionIndex,
        );

        if (footnoteReference !== null) {
          flushBuffer();
          handlers.appendNode(footnoteReference.node);
          index = footnoteReference.nextIndex;
          continue;
        }
      }
    }

    if (
      mayStartLiteralAutolinkAt(
        text,
        index,
        mayContainProtocolLiteralAutolinkCandidate,
        mayContainEmailLiteralAutolinkCandidate,
      )
    ) {
      const literalAutolink = parseAutolinkLiteral(text, index);

      if (literalAutolink !== null) {
        if (
          literalAutolink.nextIndex === text.length ||
          hasPotentialLiteralAutolinkTailToEnd(text, literalAutolink.nextIndex)
        ) {
          appendSensitiveStart = getEarlierStart(appendSensitiveStart, index);
        }

        flushBuffer();
        handlers.appendNode(literalAutolink.node);
        index = literalAutolink.nextIndex;
        continue;
      }
    }

    if (
      character === "*" ||
      character === "_" ||
      (options.gfmExtensions && character === "~")
    ) {
      flushBuffer();

      if (character === "~") {
        let runEnd = index;

        while (text[runEnd] === "~") {
          runEnd += 1;
        }

        if (runEnd - index > 2) {
          handlers.appendText(text.slice(index, runEnd));
          index = runEnd;
          continue;
        }
      }

      const delimiter = createDelimiterToken(text, index);

      if (delimiter !== null) {
        if (!delimiter.token.canOpen && !delimiter.token.canClose) {
          if (delimiter.nextIndex === text.length) {
            appendSensitiveStart = getEarlierStart(
              appendSensitiveStart,
              getDelimiterAppendSensitiveStart(
                text,
                delimiter.token.startIndex,
              ),
            );
          }

          appendToBuffer(text.slice(index, delimiter.nextIndex), index);
          index = delimiter.nextIndex;
          continue;
        }

        if (delimiter.nextIndex === text.length) {
          appendSensitiveStart = getEarlierStart(
            appendSensitiveStart,
            getDelimiterAppendSensitiveStart(text, delimiter.token.startIndex),
          );
        }

        handlers.appendDelimiter(delimiter.token);
        index = delimiter.nextIndex;
        continue;
      }

      handlers.appendText(character);
      index += 1;
      continue;
    }

    if (!allowBracketResolution && (character === "[" || character === "!")) {
      const linkOrImage = parseLinkOrImageInline(text, index, options);

      if (linkOrImage !== null) {
        flushBuffer();
        handlers.appendNode(linkOrImage.node);
        index = linkOrImage.nextIndex;
        continue;
      }
    }

    if (allowBracketResolution && character === "[" && options.allowLinks) {
      flushBuffer();
      handlers.openBracket?.(index, false);
      index += 1;
      continue;
    }

    if (
      allowBracketResolution &&
      character === "!" &&
      nextCharacter === "[" &&
      options.allowImages
    ) {
      flushBuffer();
      handlers.openBracket?.(index + 1, true);
      index += 2;
      continue;
    }

    if (allowBracketResolution && character === "]") {
      flushBuffer();
      index = handlers.closeBracket?.(index) ?? index + 1;
      continue;
    }

    if (character === "\n") {
      const trailingWhitespaceLength = countTrailingInlineWhitespace(buffer);

      if (trailingWhitespaceLength !== 0) {
        buffer = buffer.slice(0, buffer.length - trailingWhitespaceLength);
      }

      if (trailingWhitespaceLength >= 2) {
        flushBuffer();
        handlers.appendNode(createHardBreak());
      } else {
        flushBuffer();
        appendToBuffer("\n", index);
      }

      index += 1;
      continue;
    }

    const plainRunEnd = consumePlainInlineTextRun(
      text,
      index,
      options,
      mayContainProtocolLiteralAutolinkCandidate,
      mayContainEmailLiteralAutolinkCandidate,
      allowBracketResolution,
    );

    if (plainRunEnd > index) {
      const plainText = text.slice(index, plainRunEnd);
      appendToBuffer(plainText, index);
      index = plainRunEnd;
      continue;
    }

    appendToBuffer(character, index);
    index += 1;
  }

  if (bufferTrailingWhitespaceStartIndex !== undefined) {
    unresolvedStart = getEarlierStart(
      unresolvedStart,
      bufferTrailingWhitespaceStartIndex,
    );
  } else {
    appendSensitiveStart = getEarlierStart(
      appendSensitiveStart,
      findTrailingPlainAppendSensitiveStart(
        text,
        bufferStartIndex,
        buffer,
        options,
      ),
    );
  }

  buffer = trimTrailingInlineWhitespace(buffer);
  flushBuffer();

  return {
    appendSensitiveStart,
    unresolvedStart,
  };
}

function scanInlineEvents(
  text: string,
  options: InlineParseOptions,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
): ScannedInlineEvents {
  const events: InlineEvent[] = [];
  let hasEmphasisDelimiters = false;
  const scanned = scanInline(
    text,
    options,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    {
      appendText(value: string): void {
        appendInlineEvent(events, value);
      },
      appendNode(node: PhrasingContent): void {
        appendInlineToken(events, {
          kind: "node",
          node,
        });
      },
      appendDelimiter(token: InlineDelimiterToken): void {
        appendInlineToken(events, token);
        hasEmphasisDelimiters =
          hasEmphasisDelimiters || token.canOpen || token.canClose;
      },
    },
    false,
  );

  return {
    appendSensitiveStart: scanned.appendSensitiveStart,
    hasEmphasisDelimiters,
    unresolvedStart: scanned.unresolvedStart,
    events,
  };
}

function appendInlineEvent(events: InlineEvent[], value: string): void {
  if (value.length === 0) {
    return;
  }

  const previousToken = events[events.length - 1];

  if (previousToken?.kind === "text") {
    events[events.length - 1] = {
      kind: "text",
      value: previousToken.value + value,
    };
    return;
  }

  events.push({
    kind: "text",
    value,
  });
}

function createDelimiterToken(
  text: string,
  startIndex: number,
): {
  readonly nextIndex: number;
  readonly token: InlineDelimiterToken;
} | null {
  const marker = text[startIndex] as "*" | "_" | "~";
  let runEnd = startIndex;

  while (text[runEnd] === marker) {
    runEnd += 1;
  }

  if (marker === "~" && runEnd - startIndex > 2) {
    return null;
  }

  const before = getCharacterBefore(text, startIndex);
  const after = getCharacterAfter(text, runEnd);
  const leftFlanking =
    after !== undefined &&
    !isWhitespaceCharacter(after) &&
    (!isPunctuationCharacter(after) ||
      before === undefined ||
      isWhitespaceCharacter(before) ||
      isPunctuationCharacter(before));
  const rightFlanking =
    before !== undefined &&
    !isWhitespaceCharacter(before) &&
    (!isPunctuationCharacter(before) ||
      after === undefined ||
      isWhitespaceCharacter(after) ||
      isPunctuationCharacter(after));
  const canOpen =
    marker === "*"
      ? leftFlanking
      : leftFlanking &&
        (!rightFlanking ||
          before === undefined ||
          isWhitespaceCharacter(before) ||
          isPunctuationCharacter(before));
  const canClose =
    marker === "*" || marker === "~"
      ? rightFlanking
      : rightFlanking &&
        (!leftFlanking ||
          after === undefined ||
          isWhitespaceCharacter(after) ||
          isPunctuationCharacter(after));

  return {
    nextIndex: runEnd,
    token: {
      kind: "delimiter",
      canClose,
      canOpen,
      length: runEnd - startIndex,
      marker,
      startIndex,
    },
  };
}

function appendInlineNode(
  children: PhrasingContent[],
  node: PhrasingContent,
): void {
  if (node.type !== "text") {
    children.push(node);
    return;
  }

  const previousChild = children[children.length - 1];

  if (previousChild?.type === "text") {
    children[children.length - 1] = createText(
      previousChild.value + node.value,
    );
    return;
  }

  children.push(node);
}

function eventsToInlineChildren(
  events: readonly InlineEvent[],
): PhrasingContent[] {
  const children: PhrasingContent[] = [];

  for (const event of events) {
    if (event.kind === "node") {
      appendInlineNode(children, event.node);
      continue;
    }

    if (event.kind === "text") {
      appendInlineNode(children, createText(event.value));
      continue;
    }

    appendInlineNode(children, createText(event.marker.repeat(event.length)));
  }

  return children;
}

function createMutableInlineNode(
  node: PhrasingContent | null,
): MutableInlineNode {
  return {
    next: null,
    node,
    previous: null,
    projectedChildCount: 0,
  };
}

function appendMutableInlineNode(
  tail: MutableInlineNode,
  entry: MutableInlineNode,
): MutableInlineNode {
  tail.next = entry;
  entry.previous = tail;
  return entry;
}

function insertMutableInlineNodeAfter(
  reference: MutableInlineNode,
  entry: MutableInlineNode,
): void {
  const next = reference.next;

  reference.next = entry;
  entry.previous = reference;
  entry.next = next;

  if (next !== null) {
    next.previous = entry;
  }
}

function removeMutableInlineNode(entry: MutableInlineNode): void {
  const previous = entry.previous;
  const next = entry.next;

  if (previous !== null) {
    previous.next = next;
  }

  if (next !== null) {
    next.previous = previous;
  }

  entry.previous = null;
  entry.next = null;
}

function removeDelimiterEntry(
  state: MutableInlineState,
  delimiter: MutableDelimiterEntry,
): void {
  if (delimiter.previous !== null) {
    delimiter.previous.next = delimiter.next;
  }

  if (delimiter.next !== null) {
    delimiter.next.previous = delimiter.previous;
  } else {
    state.lastDelimiter = delimiter.previous;
  }

  delimiter.previous = null;
  delimiter.next = null;
}

function updateDelimiterNode(delimiter: MutableDelimiterEntry): void {
  delimiter.node.node = createText(delimiter.marker.repeat(delimiter.length));
}

function extractInlineChildrenBetween(
  opener: MutableInlineNode,
  closer: MutableInlineNode,
): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  let current = opener.next;

  while (current !== null && current !== closer) {
    const next = current.next;

    removeMutableInlineNode(current);

    if (current.node !== null) {
      appendInlineNode(children, current.node);
    }

    current = next;
  }

  return children;
}

function collectMutableInlineChildrenFrom(
  start: MutableInlineNode | null,
  prefixChildren: readonly PhrasingContent[] = [],
): PhrasingContent[] {
  const children = prefixChildren.length === 0 ? [] : [...prefixChildren];
  let current = start;

  while (current !== null) {
    if (current.node !== null) {
      appendInlineNode(children, current.node);
    }

    current.projectedChildCount = children.length;
    current = current.next;
  }

  return children;
}

function getProjectionDirtyAnchor(
  root: MutableInlineNode,
  node: MutableInlineNode,
): MutableInlineNode {
  let firstDirtyNode = node;

  while (
    firstDirtyNode !== root &&
    firstDirtyNode.node?.type === "text" &&
    firstDirtyNode.previous !== null &&
    firstDirtyNode.previous !== root &&
    firstDirtyNode.previous.node?.type === "text"
  ) {
    firstDirtyNode = firstDirtyNode.previous;
  }

  return firstDirtyNode.previous ?? root;
}

function markProjectionDirtyFromNode(
  state: MutableInlineState,
  node: MutableInlineNode,
): void {
  if (state.projectedChildren === undefined) {
    return;
  }

  const nextDirtyAnchor = getProjectionDirtyAnchor(state.root, node);

  if (
    state.projectionDirtyAnchor === null ||
    state.projectionDirtyAnchor === nextDirtyAnchor
  ) {
    state.projectionDirtyAnchor = nextDirtyAnchor;
    return;
  }

  if (
    state.projectionDirtyAnchor === state.root ||
    nextDirtyAnchor === state.root
  ) {
    state.projectionDirtyAnchor = state.root;
    return;
  }

  let current: MutableInlineNode | null = state.projectionDirtyAnchor;

  while (current !== null && current !== state.root) {
    if (current === nextDirtyAnchor) {
      state.projectionDirtyAnchor = nextDirtyAnchor;
      return;
    }

    current = current.previous;
  }
}

function projectMutableInlineChildren(
  state: MutableInlineState,
): PhrasingContent[] {
  const previousChildren = state.projectedChildren;

  if (previousChildren === undefined) {
    state.root.projectedChildCount = 0;

    const children = collectMutableInlineChildrenFrom(state.root.next);

    state.projectedChildren = children;
    state.projectionDirtyAnchor = null;
    return children;
  }

  if (state.projectionDirtyAnchor === null) {
    return previousChildren as PhrasingContent[];
  }

  const prefixChildCount = state.projectionDirtyAnchor.projectedChildCount;
  const prefixChildren =
    prefixChildCount === 0 ? [] : previousChildren.slice(0, prefixChildCount);
  const children = collectMutableInlineChildrenFrom(
    state.projectionDirtyAnchor.next,
    prefixChildren,
  );

  state.projectedChildren = children;
  state.projectionDirtyAnchor = null;
  return children;
}

function buildMutableInlineState(
  events: readonly InlineEvent[],
): MutableInlineState {
  const root = createMutableInlineNode(null);
  let tail = root;
  let lastDelimiter: MutableDelimiterEntry | null = null;

  for (const event of events) {
    const node =
      event.kind === "node"
        ? event.node
        : event.kind === "text"
          ? createText(event.value)
          : createText(event.marker.repeat(event.length));
    const inlineEntry = createMutableInlineNode(node);

    tail = appendMutableInlineNode(tail, inlineEntry);

    if (event.kind === "delimiter" && (event.canOpen || event.canClose)) {
      const delimiter: MutableDelimiterEntry = {
        canClose: event.canClose,
        canOpen: event.canOpen,
        length: event.length,
        marker: event.marker,
        next: null,
        node: inlineEntry,
        originalLength: event.length,
        previous: lastDelimiter,
        startIndex: event.startIndex,
      };

      if (lastDelimiter !== null) {
        lastDelimiter.next = delimiter;
      }

      lastDelimiter = delimiter;
    }
  }

  return {
    appendSensitiveStart: undefined,
    projectionDirtyAnchor: null,
    root,
    lastDelimiter,
  };
}

function createOptimisticDelimiterNode(
  delimiter: MutableDelimiterEntry,
  children: PhrasingContent[],
): PhrasingContent {
  const node =
    delimiter.length >= 2 ? createStrong(children) : createEmphasis(children);

  return withInlineFlags(node, OPTIMISTIC_INLINE_FLAGS);
}

function extractInlineChildrenAfter(
  start: MutableInlineNode | null,
): PhrasingContent[] {
  const children: PhrasingContent[] = [];
  let current = start;

  while (current !== null) {
    const next = current.next;

    removeMutableInlineNode(current);

    if (current.node !== null) {
      appendInlineNode(children, current.node);
    }

    current = next;
  }

  return children;
}

function applyOptimisticDelimiterClosures(state: MutableInlineState): void {
  let delimiter = state.lastDelimiter;

  while (delimiter !== null) {
    const previous = delimiter.previous;

    removeDelimiterEntry(state, delimiter);

    if (
      !delimiter.canOpen ||
      delimiter.node.next === null ||
      delimiter.marker === "~"
    ) {
      delimiter = previous;
      continue;
    }

    markProjectionDirtyFromNode(state, delimiter.node);
    const children = extractInlineChildrenAfter(delimiter.node.next);

    if (children.length === 0) {
      delimiter = previous;
      continue;
    }

    delimiter.node.node = createOptimisticDelimiterNode(delimiter, children);
    delimiter = previous;
  }
}

function suppressOptimisticTrailingStrongCloser(
  state: MutableInlineState,
): void {
  const closer = state.lastDelimiter;

  if (
    closer === null ||
    closer.length !== 1 ||
    !closer.canClose ||
    closer.canOpen ||
    closer.marker === "~"
  ) {
    return;
  }

  let opener = closer.previous;

  while (opener !== null) {
    if (
      opener.marker === closer.marker &&
      opener.length >= 2 &&
      opener.canOpen
    ) {
      closer.canClose = false;
      closer.node.node = null;
      return;
    }

    opener = opener.previous;
  }
}

function suppressOptimisticOpenBracketMarkers(
  state: MutableInlineParserState,
): void {
  let bracket = state.lastBracket;

  while (bracket !== null) {
    markProjectionDirtyFromNode(state, bracket.node);
    bracket.node.node = null;
    bracket = bracket.previous;
  }
}

function appendNodeToMutableInlineParserState(
  state: MutableInlineParserState,
  node: PhrasingContent,
): MutableInlineNode {
  const entry = createMutableInlineNode(node);

  state.tail = appendMutableInlineNode(state.tail, entry);
  return entry;
}

function isReservedTailTextNode(state: MutableInlineParserState): boolean {
  return (
    state.lastDelimiter?.node === state.tail ||
    state.lastBracket?.node === state.tail
  );
}

function appendTextToMutableInlineParserState(
  state: MutableInlineParserState,
  value: string,
  mergeWithTail = true,
): MutableInlineNode {
  if (
    mergeWithTail &&
    value.length > 0 &&
    state.tail !== state.root &&
    state.tail.node?.type === "text" &&
    !isReservedTailTextNode(state)
  ) {
    state.tail.node = createText(state.tail.node.value + value);
    return state.tail;
  }

  return appendNodeToMutableInlineParserState(state, createText(value));
}

function pushDelimiterEntry(
  state: MutableInlineState,
  node: MutableInlineNode,
  token: InlineDelimiterToken,
): void {
  if (!token.canOpen && !token.canClose) {
    return;
  }

  const delimiter: MutableDelimiterEntry = {
    canClose: token.canClose,
    canOpen: token.canOpen,
    length: token.length,
    marker: token.marker,
    next: null,
    node,
    originalLength: token.length,
    previous: state.lastDelimiter,
    startIndex: token.startIndex,
  };

  if (state.lastDelimiter !== null) {
    state.lastDelimiter.next = delimiter;
  }

  state.lastDelimiter = delimiter;
}

function addBracketEntry(
  state: MutableInlineParserState,
  node: MutableInlineNode,
  labelStartIndex: number,
  image: boolean,
): void {
  if (state.lastBracket !== null) {
    state.lastBracket.bracketAfter = true;
  }

  state.lastBracket = {
    active: true,
    bracketAfter: false,
    image,
    labelStartIndex,
    node,
    previous: state.lastBracket,
    previousDelimiter: state.lastDelimiter,
  };
}

function removeLastBracketEntry(state: MutableInlineParserState): void {
  state.lastBracket = state.lastBracket?.previous ?? null;
}

function removeDelimiterEntriesAfter(
  state: MutableInlineState,
  stackBottom: MutableDelimiterEntry | null,
): void {
  while (state.lastDelimiter !== stackBottom) {
    const delimiter = state.lastDelimiter;

    if (delimiter === null) {
      return;
    }

    removeDelimiterEntry(state, delimiter);
  }
}

function removeNodesAfter(reference: MutableInlineNode): void {
  let current = reference.next;

  while (current !== null) {
    const next = current.next;

    removeMutableInlineNode(current);
    current = next;
  }
}

function getOpenersBottomIndex(closer: MutableDelimiterEntry): number {
  const markerOffset = closer.marker === "_" ? 0 : 6;

  return markerOffset + (closer.canOpen ? 3 : 0) + (closer.originalLength % 3);
}

function hasOddMatch(
  opener: MutableDelimiterEntry,
  closer: MutableDelimiterEntry,
): boolean {
  return (
    (closer.canOpen || opener.canClose) &&
    closer.originalLength % 3 !== 0 &&
    (opener.originalLength + closer.originalLength) % 3 === 0
  );
}

function getFirstDelimiterAfter(
  lastDelimiter: MutableDelimiterEntry | null,
  stackBottom: MutableDelimiterEntry | null,
): MutableDelimiterEntry | null {
  let current = lastDelimiter;

  while (current !== null && current.previous !== stackBottom) {
    current = current.previous;
  }

  return current;
}

function markResolvedDelimiterAppendSensitiveStart(
  state: MutableInlineState,
  opener: MutableDelimiterEntry,
  closer: MutableDelimiterEntry,
): void {
  if (closer.node.next !== null) {
    return;
  }

  state.appendSensitiveStart = getEarlierStart(
    state.appendSensitiveStart,
    opener.startIndex,
  );
}

function insertEmphasis(
  state: MutableInlineState,
  opener: MutableDelimiterEntry,
  closer: MutableDelimiterEntry,
): MutableDelimiterEntry | null {
  markProjectionDirtyFromNode(state, opener.node);
  markResolvedDelimiterAppendSensitiveStart(state, opener, closer);

  const useDelimiters = opener.length >= 2 && closer.length >= 2 ? 2 : 1;

  opener.length -= useDelimiters;
  closer.length -= useDelimiters;

  updateDelimiterNode(opener);
  updateDelimiterNode(closer);

  let delimiter = closer.previous;

  while (delimiter !== null && delimiter !== opener) {
    const previous = delimiter.previous;

    removeDelimiterEntry(state, delimiter);
    delimiter = previous;
  }

  const children = extractInlineChildrenBetween(opener.node, closer.node);
  const emphasisNode = createMutableInlineNode(
    useDelimiters === 2 ? createStrong(children) : createEmphasis(children),
  );

  insertMutableInlineNodeAfter(opener.node, emphasisNode);

  if (opener.length === 0) {
    removeMutableInlineNode(opener.node);
    removeDelimiterEntry(state, opener);
  }

  if (closer.length === 0) {
    const next = closer.next;

    removeMutableInlineNode(closer.node);
    removeDelimiterEntry(state, closer);
    return next;
  }

  return closer;
}

function insertStrikethrough(
  state: MutableInlineState,
  opener: MutableDelimiterEntry,
  closer: MutableDelimiterEntry,
): MutableDelimiterEntry | null {
  markProjectionDirtyFromNode(state, opener.node);
  markResolvedDelimiterAppendSensitiveStart(state, opener, closer);

  opener.length = 0;
  closer.length = 0;

  updateDelimiterNode(opener);
  updateDelimiterNode(closer);

  let delimiter = closer.previous;

  while (delimiter !== null && delimiter !== opener) {
    const previous = delimiter.previous;

    removeDelimiterEntry(state, delimiter);
    delimiter = previous;
  }

  const children = extractInlineChildrenBetween(opener.node, closer.node);
  const deleteNode = createMutableInlineNode(createDelete(children));

  insertMutableInlineNodeAfter(opener.node, deleteNode);
  removeMutableInlineNode(opener.node);
  removeDelimiterEntry(state, opener);

  const next = closer.next;

  removeMutableInlineNode(closer.node);
  removeDelimiterEntry(state, closer);

  return next;
}

function resolveEmphasisInMutableState(
  state: MutableInlineState,
  stackBottom: MutableDelimiterEntry | null,
): void {
  const openersBottom = new Array<MutableDelimiterEntry | null>(12).fill(
    stackBottom,
  );
  let closer = getFirstDelimiterAfter(state.lastDelimiter, stackBottom);

  while (closer !== null) {
    if (closer.marker === "~" || !closer.canClose) {
      closer = closer.next;
      continue;
    }

    const openersBottomIndex = getOpenersBottomIndex(closer);
    let opener = closer.previous;
    let openerFound = false;

    while (
      opener !== null &&
      opener !== stackBottom &&
      opener !== openersBottom[openersBottomIndex]
    ) {
      if (
        opener.marker === closer.marker &&
        opener.canOpen &&
        !hasOddMatch(opener, closer)
      ) {
        openerFound = true;
        break;
      }

      opener = opener.previous;
    }

    const oldCloser = closer;

    if (openerFound && opener !== null) {
      closer = insertEmphasis(state, opener, closer);
      continue;
    }

    openersBottom[openersBottomIndex] = oldCloser.previous;

    if (!oldCloser.canOpen) {
      const next = oldCloser.next;

      removeDelimiterEntry(state, oldCloser);
      closer = next;
      continue;
    }

    closer = closer.next;
  }
}

function resolveStrikethroughInMutableState(
  state: MutableInlineState,
  stackBottom: MutableDelimiterEntry | null,
): void {
  let closer = getFirstDelimiterAfter(state.lastDelimiter, stackBottom);

  while (closer !== null) {
    const currentCloser = closer;

    if (
      closer.marker !== "~" ||
      !closer.canClose ||
      (closer.length !== 1 && closer.length !== 2)
    ) {
      closer = closer.next;
      continue;
    }

    let opener = currentCloser.previous;

    while (opener !== null && opener !== stackBottom) {
      if (
        opener.marker === "~" &&
        opener.canOpen &&
        opener.length === currentCloser.length
      ) {
        closer = insertStrikethrough(state, opener, currentCloser);
        break;
      }

      opener = opener.previous;
    }

    if (opener === null || opener === stackBottom) {
      closer = currentCloser.next;
    }
  }
}

function parseReferenceLinkTail(
  text: string,
  closeBracketIndex: number,
  opener: MutableBracketEntry,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
): ParsedLinkReferenceTail | null {
  let nextIndex = closeBracketIndex + 1;
  let label: string | null = null;

  if (text[nextIndex] === "[") {
    const parsedLabel = parseReferenceLabelToken(text, nextIndex);

    if (parsedLabel !== null && parsedLabel.label.length > 0) {
      label = parsedLabel.label;
      nextIndex = parsedLabel.nextIndex;
    } else if (parsedLabel !== null && !opener.bracketAfter) {
      label = text.slice(opener.labelStartIndex + 1, closeBracketIndex);
      nextIndex = parsedLabel.nextIndex;
    } else {
      return null;
    }
  } else if (!opener.bracketAfter) {
    label = text.slice(opener.labelStartIndex + 1, closeBracketIndex);
  } else {
    return null;
  }

  const definition = findReferenceDefinition(
    definitions,
    label,
    definitionIndex,
  );

  return definition === null
    ? null
    : {
        definition,
        nextIndex,
      };
}

function createLinkLabelChildren(
  label: string,
  isImage: boolean,
  gfmExtensions: boolean,
  mathExtensions: boolean,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
): PhrasingContent[] {
  return createInlineChildren(
    label,
    isImage
      ? {
          allowImages: true,
          allowLinks: true,
          gfmExtensions,
          mathExtensions,
        }
      : {
          allowImages: true,
          allowLinks: false,
          gfmExtensions,
          mathExtensions,
        },
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
  );
}

function getBracketSyntaxStart(opener: MutableBracketEntry): number {
  return opener.image ? opener.labelStartIndex - 1 : opener.labelStartIndex;
}

function findTrailingBracketAppendSensitiveStart(
  state: MutableInlineParserState,
  opener: MutableBracketEntry,
  closeBracketIndex: number,
): number | undefined {
  const nextCharacterIndex = closeBracketIndex + 1;
  const nextCharacter = state.text[nextCharacterIndex];

  if (nextCharacter === undefined) {
    return getBracketSyntaxStart(opener);
  }

  if (nextCharacter === "(") {
    return getBracketSyntaxStart(opener);
  }

  if (nextCharacter !== "[") {
    return undefined;
  }

  return parseReferenceLabelToken(state.text, nextCharacterIndex) === null
    ? getBracketSyntaxStart(opener)
    : undefined;
}

function resolveBracketCloser(
  state: MutableInlineParserState,
  closeBracketIndex: number,
): number {
  const opener = state.lastBracket;
  const nextCharacterIndex = closeBracketIndex + 1;

  if (opener === null) {
    appendTextToMutableInlineParserState(state, "]");
    return nextCharacterIndex;
  }

  if (!opener.active) {
    appendTextToMutableInlineParserState(state, "]");
    removeLastBracketEntry(state);
    return nextCharacterIndex;
  }

  let nextIndex = nextCharacterIndex;
  let destination: ParsedLinkDestination | null = null;
  let referenceTail: ParsedLinkReferenceTail | null = null;

  if (state.text[nextIndex] === "(") {
    destination = parseInlineLinkDestination(state.text, nextIndex + 1);
  }

  if (destination !== null) {
    nextIndex = destination.nextIndex;
  } else {
    referenceTail = parseReferenceLinkTail(
      state.text,
      closeBracketIndex,
      opener,
      state.definitions,
      state.definitionIndex,
    );

    if (referenceTail !== null) {
      nextIndex = referenceTail.nextIndex;
    }
  }

  if (destination === null && referenceTail === null) {
    state.appendSensitiveStart = getEarlierStart(
      state.appendSensitiveStart,
      findTrailingBracketAppendSensitiveStart(state, opener, closeBracketIndex),
    );
    appendTextToMutableInlineParserState(state, "]");
    removeLastBracketEntry(state);
    return nextCharacterIndex;
  }

  markProjectionDirtyFromNode(state, opener.node);

  const label = state.text.slice(opener.labelStartIndex + 1, closeBracketIndex);
  const labelChildren = createLinkLabelChildren(
    label,
    opener.image,
    state.options.gfmExtensions,
    state.options.mathExtensions,
    state.definitions,
    state.definitionIndex,
    state.footnoteDefinitions,
    state.footnoteDefinitionIndex,
  );

  removeDelimiterEntriesAfter(state, opener.previousDelimiter);
  removeNodesAfter(opener.node);
  opener.node.node = opener.image
    ? createImage(
        destination?.url ?? referenceTail?.definition.url ?? "",
        extractPlainText(labelChildren),
        destination?.title ?? referenceTail?.definition.title,
      )
    : createLink(
        labelChildren,
        destination?.url ?? referenceTail?.definition.url ?? "",
        destination?.title ?? referenceTail?.definition.title,
      );
  state.tail = opener.node;
  removeLastBracketEntry(state);

  if (!opener.image) {
    let bracket = state.lastBracket;

    while (bracket !== null) {
      if (!bracket.image) {
        bracket.active = false;
      }

      bracket = bracket.previous;
    }
  }

  return nextIndex;
}

function finalizeBracketInlineState(
  state: MutableInlineParserState,
  explicitUnresolvedStart?: number,
  explicitAppendSensitiveStart?: number,
  projectionMode: InlineProjectionMode = "exact",
): ParsedBracketInlineChildren {
  if (projectionMode === "optimistic") {
    suppressOptimisticTrailingStrongCloser(state);
    suppressOptimisticOpenBracketMarkers(state);
  }

  resolveEmphasisInMutableState(state, null);
  resolveStrikethroughInMutableState(state, null);

  let unresolvedStart = getEarlierStart(
    explicitUnresolvedStart,
    getEarliestUnresolvedDelimiterStart(state.lastDelimiter),
  );
  unresolvedStart = getEarlierStart(
    unresolvedStart,
    getEarliestUnresolvedBracketStart(state.lastBracket),
  );

  if (projectionMode === "optimistic") {
    applyOptimisticDelimiterClosures(state);
  }

  const appendSensitiveStart = getEarlierStart(
    explicitAppendSensitiveStart,
    state.appendSensitiveStart,
  );

  return {
    appendSafeOffset: getInlineAppendSafeOffset(
      state.text,
      unresolvedStart,
      appendSensitiveStart,
    ),
    appendSensitiveStart,
    children: projectMutableInlineChildren(state),
    explicitAppendSensitiveStart,
    explicitUnresolvedStart,
    state,
    unresolvedStart,
  };
}

function parseInlineChildrenWithBrackets(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
): ParsedBracketInlineChildren {
  const root = createMutableInlineNode(null);
  const state: MutableInlineParserState = {
    appendSensitiveStart: undefined,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    lastBracket: null,
    lastDelimiter: null,
    options,
    projectionDirtyAnchor: null,
    root,
    tail: root,
    text,
  };

  const scanned = scanInline(
    text,
    options,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    {
      appendText(value: string): void {
        appendTextToMutableInlineParserState(state, value);
      },
      appendNode(node: PhrasingContent): void {
        appendNodeToMutableInlineParserState(state, node);
      },
      appendDelimiter(token: InlineDelimiterToken): void {
        const node = appendTextToMutableInlineParserState(
          state,
          token.marker.repeat(token.length),
          false,
        );

        pushDelimiterEntry(state, node, token);
      },
      openBracket(labelStartIndex: number, image: boolean): void {
        const node = appendTextToMutableInlineParserState(
          state,
          image ? "![" : "[",
          false,
        );

        addBracketEntry(state, node, labelStartIndex, image);
      },
      closeBracket(closeBracketIndex: number): number {
        return resolveBracketCloser(state, closeBracketIndex);
      },
    },
    true,
  );

  return finalizeBracketInlineState(
    state,
    scanned.unresolvedStart,
    scanned.appendSensitiveStart,
  );
}

function countTrailingInlineWhitespace(value: string): number {
  let length = 0;

  for (let index = value.length - 1; index >= 0; index -= 1) {
    const character = value[index];

    if (character !== " " && character !== "\t") {
      break;
    }

    length += 1;
  }

  return length;
}

function trimTrailingInlineWhitespace(value: string): string {
  const trailingWhitespaceLength = countTrailingInlineWhitespace(value);

  return trailingWhitespaceLength === 0
    ? value
    : value.slice(0, value.length - trailingWhitespaceLength);
}

function needsPlainInlineNormalization(text: string): boolean {
  let hasTrailingWhitespace = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === " " || character === "\t") {
      hasTrailingWhitespace = true;
      continue;
    }

    if (character === "\n") {
      if (hasTrailingWhitespace) {
        return true;
      }

      continue;
    }

    hasTrailingWhitespace = false;
  }

  return hasTrailingWhitespace;
}

function normalizePlainInlineText(text: string): string {
  if (!needsPlainInlineNormalization(text)) {
    return text;
  }

  let normalized = "";
  let segmentStart = 0;
  let segmentEnd = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === "\n") {
      normalized += text.slice(segmentStart, segmentEnd);
      normalized += "\n";
      segmentStart = index + 1;
      segmentEnd = segmentStart;
      continue;
    }

    if (character !== " " && character !== "\t") {
      segmentEnd = index + 1;
    }
  }

  return normalized + text.slice(segmentStart, segmentEnd);
}

function canUseSingleLinePlainInlineFastPath(
  text: string,
  options: InlineParseOptions,
): boolean {
  if (text.length === 0) {
    return false;
  }

  const lastCharacter = text[text.length - 1];

  if (lastCharacter === " " || lastCharacter === "\t") {
    return false;
  }

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (
      character === "\n" ||
      character === "\\" ||
      character === "`" ||
      character === "&" ||
      character === "<" ||
      character === "*" ||
      character === "_" ||
      character === "[" ||
      (options.allowImages && character === "!") ||
      (options.gfmExtensions && character === "~") ||
      (options.mathExtensions && character === "$")
    ) {
      return false;
    }

    if (!options.gfmExtensions || !options.allowLinks) {
      continue;
    }

    if (
      character === "@" ||
      (character === "h" &&
        (text.startsWith("http://", index) ||
          text.startsWith("https://", index))) ||
      (character === "f" && text.startsWith("ftp://", index)) ||
      (character === "w" && text.startsWith("www.", index)) ||
      (character === "m" && text.startsWith("mailto:", index)) ||
      (character === "x" && text.startsWith("xmpp:", index))
    ) {
      return false;
    }
  }

  return true;
}

function canUsePlainInlineFastPath(
  text: string,
  options: InlineParseOptions,
): boolean {
  if (
    options.gfmExtensions &&
    options.allowLinks &&
    mayContainGfmLiteralAutolink(text)
  ) {
    return false;
  }

  let trailingWhitespaceLength = 0;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === " " || character === "\t") {
      trailingWhitespaceLength += 1;
      continue;
    }

    if (character === "\n") {
      if (trailingWhitespaceLength >= 2) {
        return false;
      }

      trailingWhitespaceLength = 0;
      continue;
    }

    trailingWhitespaceLength = 0;

    if (
      character === "\\" ||
      character === "`" ||
      (options.mathExtensions && character === "$") ||
      character === "&" ||
      character === "<" ||
      character === "*" ||
      (options.gfmExtensions && character === "~") ||
      character === "_" ||
      (options.allowLinks && character === "[") ||
      (options.allowImages &&
        character === "!" &&
        (text[index + 1] ?? "") === "[")
    ) {
      return false;
    }
  }

  return true;
}

function resolveInlineDelimiters(
  events: readonly InlineEvent[],
  projectionMode: InlineProjectionMode,
): {
  readonly appendSensitiveStart?: number;
  readonly children: PhrasingContent[];
  readonly unresolvedStart?: number;
} {
  const state = buildMutableInlineState(events);

  if (projectionMode === "optimistic") {
    suppressOptimisticTrailingStrongCloser(state);
  }

  resolveEmphasisInMutableState(state, null);
  resolveStrikethroughInMutableState(state, null);

  const unresolvedStart = getEarliestUnresolvedDelimiterStart(
    state.lastDelimiter,
  );

  if (projectionMode === "optimistic") {
    applyOptimisticDelimiterClosures(state);
  }

  return {
    appendSensitiveStart: state.appendSensitiveStart,
    children: projectMutableInlineChildren(state),
    unresolvedStart,
  };
}

function isBracketInlineResumeState(
  value: unknown,
): value is BracketInlineResumeState {
  return (
    typeof value === "object" &&
    value !== null &&
    "kind" in value &&
    value.kind === "brackets" &&
    "state" in value
  );
}

function parseInlineChildren(
  text: string,
  options: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
  definitions: readonly InternalLinkReferenceDefinition[] = [],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  projectionMode: InlineProjectionMode = "exact",
): ParsedInlineChildren {
  if (text.length === 0) {
    return {
      appendSafeOffset: 0,
      children: [],
    };
  }

  if (canUseSingleLinePlainInlineFastPath(text, options)) {
    const appendSensitiveStart = findTrailingPlainAppendSensitiveStart(
      text,
      0,
      text,
      options,
    );

    return {
      appendSafeOffset: getInlineAppendSafeOffset(
        text,
        undefined,
        appendSensitiveStart,
      ),
      children: finalizeInlineChildren([createText(text)]),
      appendSensitiveStart,
      events: [{ kind: "text", value: text }],
    };
  }

  if (canUsePlainInlineFastPath(text, options)) {
    const normalizedText = normalizePlainInlineText(text);
    const trailingWhitespaceLength = countTrailingInlineWhitespace(text);
    const appendSensitiveStart =
      trailingWhitespaceLength === 0
        ? findTrailingPlainAppendSensitiveStart(text, 0, text, options)
        : undefined;

    return {
      appendSafeOffset: getInlineAppendSafeOffset(
        text,
        trailingWhitespaceLength === 0
          ? undefined
          : text.length - trailingWhitespaceLength,
        appendSensitiveStart,
      ),
      children:
        normalizedText.length === 0
          ? []
          : finalizeInlineChildren([createText(normalizedText)]),
      appendSensitiveStart,
      events:
        normalizedText.length === 0
          ? []
          : [{ kind: "text", value: normalizedText }],
      unresolvedStart:
        trailingWhitespaceLength === 0
          ? undefined
          : text.length - trailingWhitespaceLength,
    };
  }

  if (text.includes("[")) {
    const parsed = parseInlineChildrenWithBrackets(
      text,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );
    const projected =
      projectionMode === "optimistic"
        ? finalizeBracketInlineState(
            parsed.state,
            parsed.explicitUnresolvedStart,
            parsed.explicitAppendSensitiveStart,
            "optimistic",
          )
        : parsed;

    return {
      appendSafeOffset: projected.appendSafeOffset,
      children: finalizeInlineChildren(projected.children),
      appendSensitiveStart: projected.appendSensitiveStart,
      resumeState:
        projectionMode === "exact" &&
        projected.unresolvedStart !== undefined &&
        projected.explicitUnresolvedStart === undefined
          ? {
              kind: "brackets",
              state: projected.state,
            }
          : undefined,
      unresolvedStart: projected.unresolvedStart,
    };
  }

  const {
    appendSensitiveStart,
    events,
    hasEmphasisDelimiters,
    unresolvedStart,
  } = scanInlineEvents(
    text,
    options,
    footnoteDefinitions,
    footnoteDefinitionIndex,
  );

  if (events.length === 0) {
    return {
      appendSafeOffset: getInlineAppendSafeOffset(
        text,
        unresolvedStart,
        appendSensitiveStart,
      ),
      children: [],
      appendSensitiveStart,
      events: [],
      unresolvedStart,
    };
  }

  if (!hasEmphasisDelimiters) {
    return {
      appendSafeOffset: getInlineAppendSafeOffset(
        text,
        unresolvedStart,
        appendSensitiveStart,
      ),
      children: finalizeInlineChildren(eventsToInlineChildren(events)),
      appendSensitiveStart,
      events,
      unresolvedStart,
    };
  }

  const resolved = resolveInlineDelimiters(events, projectionMode);
  const resolvedAppendSensitiveStart = getEarlierStart(
    appendSensitiveStart,
    resolved.appendSensitiveStart,
  );

  return {
    appendSafeOffset: getInlineAppendSafeOffset(
      text,
      getEarlierStart(unresolvedStart, resolved.unresolvedStart),
      resolvedAppendSensitiveStart,
    ),
    children: finalizeInlineChildren(resolved.children),
    appendSensitiveStart: resolvedAppendSensitiveStart,
    events,
    unresolvedStart: getEarlierStart(unresolvedStart, resolved.unresolvedStart),
  };
}

export function createInlineChildren(
  text: string,
  options: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
  definitions: readonly InternalLinkReferenceDefinition[] = [],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
): PhrasingContent[] {
  return parseInlineChildren(
    text,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
  ).children;
}

function createProjectedInlineChildren(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
  projectionMode: InlineProjectionMode,
): PhrasingContent[] {
  return parseInlineChildren(
    text,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    projectionMode,
  ).children;
}

function createInlineChildrenPreservingTrailingWhitespace(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
): PhrasingContent[] {
  const trailingWhitespaceLength = countTrailingInlineWhitespace(text);

  if (trailingWhitespaceLength === 0) {
    return createInlineChildren(
      text,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );
  }

  const prefixText = text.slice(0, text.length - trailingWhitespaceLength);
  const prefixChildren =
    prefixText.length === 0
      ? []
      : createInlineChildren(
          prefixText,
          options,
          definitions,
          definitionIndex,
          footnoteDefinitions,
          footnoteDefinitionIndex,
        );

  return mergeInlineChildren(prefixChildren, [
    createText(text.slice(text.length - trailingWhitespaceLength)),
  ]);
}

function mergeInlineChildren(
  prefixChildren: readonly PhrasingContent[],
  suffixChildren: readonly PhrasingContent[],
): PhrasingContent[] {
  if (prefixChildren.length === 0) {
    return suffixChildren as PhrasingContent[];
  }

  if (suffixChildren.length === 0) {
    return prefixChildren as PhrasingContent[];
  }

  const children: PhrasingContent[] = [...prefixChildren];

  for (const child of suffixChildren) {
    appendInlineNode(children, child);
  }

  return children;
}

function mayNeedOptimisticInlineProjection(
  text: string,
  unresolvedStart: number | undefined,
  options: InlineParseOptions,
): boolean {
  if (unresolvedStart === undefined || unresolvedStart >= text.length) {
    return false;
  }

  const suffix = text.slice(unresolvedStart);

  return (
    suffix.includes("*") ||
    suffix.includes("_") ||
    suffix.includes("`") ||
    ((options.allowLinks || options.allowImages) && suffix.includes("[")) ||
    ((options.allowLinks || options.allowImages) && suffix.includes("<")) ||
    (options.mathExtensions && suffix.includes("$")) ||
    (options.mathExtensions && suffix.includes("\\"))
  );
}

function appendOptimisticInlineLinkDestinationCloser(
  text: string,
  options: InlineParseOptions,
): string {
  return (
    findOptimisticInlineLinkDestinationProjection(text, options)
      ?.completedText ?? text
  );
}

function isEscapedInlineCharacter(text: string, index: number): boolean {
  let backslashCount = 0;

  for (let current = index - 1; current >= 0; current -= 1) {
    if (text[current] !== "\\") {
      break;
    }

    backslashCount += 1;
  }

  return backslashCount % 2 === 1;
}

function findOptimisticInlineLinkDestinationProjection(
  text: string,
  options: InlineParseOptions,
): { readonly completedText: string; readonly startIndex: number } | null {
  if (!options.allowLinks && !options.allowImages) {
    return null;
  }

  const completedTexts = text.includes("](<")
    ? [`${text})`, `${text}>)`]
    : [`${text})`];

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    const startsImage = character === "!" && text[index + 1] === "[";
    const startsLink = character === "[";

    if (!startsLink && !startsImage) {
      continue;
    }

    if (
      (startsLink && isEscapedInlineCharacter(text, index)) ||
      (startsImage &&
        (isEscapedInlineCharacter(text, index) ||
          isEscapedInlineCharacter(text, index + 1)))
    ) {
      continue;
    }

    for (const completedText of completedTexts) {
      const parsed = parseLinkOrImageInline(completedText, index, options);

      if (parsed !== null && parsed.nextIndex === completedText.length) {
        return {
          completedText,
          startIndex: index,
        };
      }
    }
  }

  return null;
}

function findOptimisticTrailingLinkLabelProjection(
  text: string,
  options: InlineParseOptions,
): {
  readonly labelEndIndex: number;
  readonly labelStartIndex: number;
  readonly startIndex: number;
} | null {
  if (!options.allowLinks && !options.allowImages) {
    return null;
  }

  const labelEndIndex = findOptimisticTrailingLinkLabelEnd(text);

  if (labelEndIndex === null) {
    return null;
  }

  for (let index = 0; index < labelEndIndex; index += 1) {
    if (text[index] !== "[") {
      continue;
    }

    if (isEscapedInlineCharacter(text, index)) {
      continue;
    }

    if (text[index - 1] === "!" && !isEscapedInlineCharacter(text, index - 1)) {
      if (!options.allowImages) {
        continue;
      }

      if (findLinkLabelEnd(text, index + 1) === labelEndIndex) {
        return {
          labelEndIndex,
          labelStartIndex: index + 1,
          startIndex: index - 1,
        };
      }

      continue;
    }

    if (text[index - 1] === "]") {
      continue;
    }

    if (findLinkLabelEnd(text, index + 1) === labelEndIndex) {
      return {
        labelEndIndex,
        labelStartIndex: index + 1,
        startIndex: index,
      };
    }
  }

  return null;
}

function findOptimisticTrailingLinkLabelEnd(text: string): number | null {
  if (text.endsWith("]")) {
    return text.length - 1;
  }

  const destinationStart = text.lastIndexOf("](");

  if (
    destinationStart !== -1 &&
    !text.slice(destinationStart + 2).includes(")")
  ) {
    return destinationStart;
  }

  return null;
}

function findOptimisticTrailingDelimiterMarkerProjection(
  text: string,
): number | null {
  const marker = text[text.length - 1];

  if (marker !== "*" && marker !== "_") {
    return null;
  }

  let startIndex = text.length - 1;

  while (startIndex > 0 && text[startIndex - 1] === marker) {
    startIndex -= 1;
  }

  const markerLength = text.length - startIndex;

  if (markerLength > 2) {
    return null;
  }

  if (isEscapedInlineCharacter(text, startIndex)) {
    return null;
  }

  const previousCharacter = text[startIndex - 1];

  return previousCharacter === undefined ||
    isWhitespaceCharacter(previousCharacter)
    ? startIndex
    : null;
}

function mayNeedOptimisticInlineLinkDestinationProjection(
  text: string,
  options: InlineParseOptions,
): boolean {
  return (options.allowLinks || options.allowImages) && text.includes("](");
}

function mayNeedOptimisticCompletedInlineProjection(
  text: string,
  options: InlineParseOptions,
): boolean {
  const lastCharacter = text[text.length - 1];

  if (
    lastCharacter === "`" ||
    lastCharacter === "*" ||
    lastCharacter === "_" ||
    text.includes("<")
  ) {
    return true;
  }

  if (
    (options.allowLinks || options.allowImages) &&
    (lastCharacter === "]" || text.includes("]("))
  ) {
    return true;
  }

  if (options.allowImages && lastCharacter === "!") {
    return true;
  }

  if (options.mathExtensions && (text.includes("$") || text.includes("\\"))) {
    return true;
  }

  return false;
}

function appendOptimisticParenthesizedInlineMathCloser(
  text: string,
  options: InlineParseOptions,
): string {
  if (!options.mathExtensions || !text.includes("\\")) {
    return text;
  }

  const completedText = text.endsWith("\\") ? `${text})` : `${text}\\)`;

  for (let index = 0; index < text.length; index += 1) {
    if (!completedText.startsWith("\\(", index)) {
      continue;
    }

    const parsed = parseParenthesizedInlineMath(completedText, index);

    if (parsed !== null && parsed.nextIndex === completedText.length) {
      return completedText;
    }
  }

  const unresolvedStart = findUnresolvedParenthesizedInlineMathStart(text);

  if (unresolvedStart !== undefined) {
    return text.slice(0, unresolvedStart);
  }

  if (text.endsWith("\\")) {
    return text.slice(0, -1);
  }

  return text;
}

function findUnresolvedParenthesizedInlineMathStart(
  text: string,
): number | undefined {
  for (let index = text.length - 2; index >= 0; index -= 1) {
    if (!text.startsWith("\\(", index)) {
      continue;
    }

    if (text.slice(index + 2).includes("\n")) {
      return undefined;
    }

    if (parseParenthesizedInlineMath(text, index) === null) {
      return index;
    }
  }

  return undefined;
}

function suppressOptimisticDollarInlineMathTail(
  text: string,
  options: InlineParseOptions,
): string {
  if (!options.mathExtensions || !text.includes("$")) {
    return text;
  }

  for (let index = text.length - 1; index >= 0; index -= 1) {
    if (text[index] !== "$" || isEscapedInlineCharacter(text, index)) {
      continue;
    }

    if (parseDollarInlineMath(text, index) !== "unresolved") {
      continue;
    }

    return text.slice(0, index);
  }

  return text;
}

function suppressOptimisticInlineLinkDestinationTail(text: string): string {
  const destinationStart = text.lastIndexOf("](");

  if (
    destinationStart === -1 ||
    text.slice(destinationStart + 2).includes(")")
  ) {
    return text;
  }

  const labelStart = text.lastIndexOf("[", destinationStart);

  if (labelStart === -1 || isEscapedInlineCharacter(text, labelStart)) {
    return text;
  }

  return text.slice(0, destinationStart + 1);
}

function completeOptimisticAngleAutolinkTailText(text: string): string {
  const startIndex = text.lastIndexOf("<");

  if (startIndex === -1 || text.slice(startIndex + 1).includes(">")) {
    return text;
  }

  const tail = text.slice(startIndex + 1).toLowerCase();

  if (
    !"http://".startsWith(tail) &&
    !"https://".startsWith(tail) &&
    !"mailto:".startsWith(tail) &&
    !tail.startsWith("http://") &&
    !tail.startsWith("https://") &&
    !tail.startsWith("mailto:")
  ) {
    return text;
  }

  const completedText = `${text}>`;
  const parsed = parseAutolinkInline(completedText, startIndex);

  if (parsed !== null && parsed.nextIndex === completedText.length) {
    return completedText;
  }

  return text.slice(0, startIndex);
}

function appendOptimisticInlineCodeCloser(text: string): string {
  let index = 0;

  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }

    const codeSpan = parseCodeSpan(text, index);

    if (codeSpan !== null) {
      index = codeSpan.nextIndex;
      continue;
    }

    const backtickLength = countBackticks(text, index);

    if (index + backtickLength === text.length) {
      return text.slice(0, index);
    }

    let trailingBacktickLength = 0;

    while (
      trailingBacktickLength < text.length &&
      text[text.length - trailingBacktickLength - 1] === "`"
    ) {
      trailingBacktickLength += 1;
    }

    if (trailingBacktickLength > 0 && trailingBacktickLength < backtickLength) {
      return `${text.slice(0, -trailingBacktickLength)}${"`".repeat(
        backtickLength,
      )}`;
    }

    return `${text}${"`".repeat(backtickLength)}`;
  }

  return text;
}

function suppressOptimisticImageOpenerTail(text: string): string {
  return text.endsWith("!") ? text.slice(0, -1) : text;
}

function completeOptimisticInlineTailText(
  text: string,
  options: InlineParseOptions,
): string {
  let completedText = appendOptimisticInlineLinkDestinationCloser(
    text,
    options,
  );
  completedText = suppressOptimisticInlineLinkDestinationTail(completedText);
  completedText = completeOptimisticAngleAutolinkTailText(completedText);
  completedText = suppressOptimisticDollarInlineMathTail(
    completedText,
    options,
  );
  completedText = appendOptimisticParenthesizedInlineMathCloser(
    completedText,
    options,
  );
  completedText = appendOptimisticInlineCodeCloser(completedText);

  return options.allowImages
    ? suppressOptimisticImageOpenerTail(completedText)
    : completedText;
}

function createOptimisticInlineChildren(
  text: string,
  unresolvedStart: number | undefined,
  stablePrefixChildren: readonly PhrasingContent[],
  stablePrefixLength: number,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
  exactChildren: readonly PhrasingContent[],
): PhrasingContent[] | undefined {
  if (unresolvedStart === undefined) {
    if (!mayNeedOptimisticCompletedInlineProjection(text, options)) {
      return undefined;
    }

    const linkProjection = mayNeedOptimisticInlineLinkDestinationProjection(
      text,
      options,
    )
      ? findOptimisticInlineLinkDestinationProjection(text, options)
      : null;

    if (linkProjection === null) {
      const completedText = completeOptimisticInlineTailText(text, options);

      if (completedText !== text) {
        const optimisticChildren = createProjectedInlineChildren(
          completedText,
          options,
          definitions,
          definitionIndex,
          footnoteDefinitions,
          footnoteDefinitionIndex,
          "optimistic",
        );

        return arePhrasingChildrenEqual(exactChildren, optimisticChildren)
          ? undefined
          : optimisticChildren;
      }

      const labelProjection = findOptimisticTrailingLinkLabelProjection(
        text,
        options,
      );

      if (labelProjection === null) {
        const delimiterProjection =
          findOptimisticTrailingDelimiterMarkerProjection(text);

        if (delimiterProjection === null) {
          return undefined;
        }

        const optimisticChildren =
          createInlineChildrenPreservingTrailingWhitespace(
            text.slice(0, delimiterProjection),
            options,
            definitions,
            definitionIndex,
            footnoteDefinitions,
            footnoteDefinitionIndex,
          );

        return arePhrasingChildrenEqual(exactChildren, optimisticChildren)
          ? undefined
          : optimisticChildren;
      }

      const lastExactChild = exactChildren.at(-1);

      if (lastExactChild?.type === "image" || lastExactChild?.type === "link") {
        return undefined;
      }

      const optimisticPrefixChildren =
        labelProjection.startIndex === 0
          ? []
          : createInlineChildrenPreservingTrailingWhitespace(
              text.slice(0, labelProjection.startIndex),
              options,
              definitions,
              definitionIndex,
              footnoteDefinitions,
              footnoteDefinitionIndex,
            );
      const optimisticLabelChildren = createProjectedInlineChildren(
        text.slice(
          labelProjection.labelStartIndex,
          labelProjection.labelEndIndex,
        ),
        {
          allowImages: true,
          allowLinks: false,
          gfmExtensions: options.gfmExtensions,
          mathExtensions: options.mathExtensions,
        },
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        "optimistic",
      );
      const optimisticChildren = mergeInlineChildren(
        optimisticPrefixChildren,
        flagOptimisticInlineChildren(optimisticLabelChildren),
      );

      return arePhrasingChildrenEqual(exactChildren, optimisticChildren)
        ? undefined
        : optimisticChildren;
    }

    const optimisticPrefixChildren =
      linkProjection.startIndex === 0
        ? []
        : createInlineChildrenPreservingTrailingWhitespace(
            text.slice(0, linkProjection.startIndex),
            options,
            definitions,
            definitionIndex,
            footnoteDefinitions,
            footnoteDefinitionIndex,
          );
    const optimisticSuffixChildren = createProjectedInlineChildren(
      linkProjection.completedText.slice(linkProjection.startIndex),
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      "optimistic",
    );
    const optimisticChildren = mergeInlineChildren(
      optimisticPrefixChildren,
      flagOptimisticInlineChildren(optimisticSuffixChildren),
    );

    if (arePhrasingChildrenEqual(exactChildren, optimisticChildren)) {
      return undefined;
    }

    return optimisticChildren;
  }

  if (
    !mayNeedOptimisticInlineProjection(text, unresolvedStart, options) ||
    stablePrefixLength >= text.length
  ) {
    return undefined;
  }

  const suffixText = text.slice(stablePrefixLength);
  if (options.mathExtensions && suffixText.endsWith("\\(")) {
    const openerIndex = text.length - 2;

    if (!isEscapedInlineCharacter(text, openerIndex)) {
      const optimisticSuffixChildren = createProjectedInlineChildren(
        suffixText.slice(0, -2),
        options,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
        "optimistic",
      );

      return mergeInlineChildren(
        stablePrefixChildren,
        flagOptimisticInlineChildren(optimisticSuffixChildren),
      );
    }
  }

  const completedSuffixText = completeOptimisticInlineTailText(
    suffixText,
    options,
  );
  const optimisticSuffixChildren = createProjectedInlineChildren(
    completedSuffixText,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    "optimistic",
  );
  const exactSuffixChildren =
    completedSuffixText === suffixText && stablePrefixLength === 0
      ? exactChildren
      : completedSuffixText === suffixText
        ? createInlineChildren(
            suffixText,
            options,
            definitions,
            definitionIndex,
            footnoteDefinitions,
            footnoteDefinitionIndex,
          )
        : undefined;

  if (
    exactSuffixChildren !== undefined &&
    arePhrasingChildrenEqual(exactSuffixChildren, optimisticSuffixChildren)
  ) {
    return undefined;
  }

  return mergeInlineChildren(
    stablePrefixChildren,
    flagOptimisticInlineChildren(optimisticSuffixChildren),
  );
}

function createStablePrefixChildren(
  text: string,
  stablePrefixLength: number,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
): PhrasingContent[] {
  return stablePrefixLength === 0
    ? []
    : createInlineChildrenPreservingTrailingWhitespace(
        text.slice(0, stablePrefixLength),
        options,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
      );
}

function shareStablePrefixChildReferences(
  stablePrefixChildren: readonly PhrasingContent[],
  exactChildren: readonly PhrasingContent[],
): PhrasingContent[] {
  if (
    stablePrefixChildren === exactChildren ||
    stablePrefixChildren.length === 0 ||
    exactChildren.length === 0
  ) {
    return stablePrefixChildren as PhrasingContent[];
  }

  const sharedPrefixChildren: PhrasingContent[] = [];
  let exactIndex = 0;

  for (
    let stableIndex = 0;
    stableIndex < stablePrefixChildren.length;
    stableIndex += 1
  ) {
    const stableChild = stablePrefixChildren[stableIndex];
    const exactChild = exactChildren[exactIndex];

    if (stableChild === undefined || exactChild === undefined) {
      return appendStablePrefixRemainder(
        sharedPrefixChildren,
        stablePrefixChildren,
        stableIndex,
      );
    }

    if (stableChild.type === "text" && exactChild.type === "text") {
      if (stableChild.value === exactChild.value) {
        sharedPrefixChildren.push(exactChild);
        exactIndex += 1;
        continue;
      }

      if (exactChild.value.startsWith(stableChild.value)) {
        return appendStablePrefixRemainder(
          sharedPrefixChildren,
          stablePrefixChildren,
          stableIndex,
        );
      }

      return appendStablePrefixRemainder(
        sharedPrefixChildren,
        stablePrefixChildren,
        stableIndex,
      );
    }

    if (arePhrasingNodesEqual(stableChild, exactChild)) {
      sharedPrefixChildren.push(exactChild);
      exactIndex += 1;
      continue;
    }

    return appendStablePrefixRemainder(
      sharedPrefixChildren,
      stablePrefixChildren,
      stableIndex,
    );
  }

  return sharedPrefixChildren;
}

function appendStablePrefixRemainder(
  sharedPrefixChildren: readonly PhrasingContent[],
  stablePrefixChildren: readonly PhrasingContent[],
  stableIndex: number,
): PhrasingContent[] {
  if (sharedPrefixChildren.length === 0) {
    return stablePrefixChildren as PhrasingContent[];
  }

  if (stableIndex >= stablePrefixChildren.length) {
    return sharedPrefixChildren as PhrasingContent[];
  }

  const combinedChildren = new Array<PhrasingContent>(
    sharedPrefixChildren.length + stablePrefixChildren.length - stableIndex,
  );
  let writeIndex = 0;

  for (const child of sharedPrefixChildren) {
    combinedChildren[writeIndex] = child;
    writeIndex += 1;
  }

  for (
    let remainingIndex = stableIndex;
    remainingIndex < stablePrefixChildren.length;
    remainingIndex += 1
  ) {
    const child = stablePrefixChildren[remainingIndex];

    if (child === undefined) {
      continue;
    }

    combinedChildren[writeIndex] = child;
    writeIndex += 1;
  }

  return combinedChildren;
}

function isPlainTextLiteralAutolinkContinuationSegment(
  text: string,
  startIndex: number,
  endIndex: number,
  options: InlineParseOptions,
): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    const character = text[index] ?? "";

    if (
      character === "\n" ||
      character === "\r" ||
      character === "\\" ||
      character === "`" ||
      character === "&" ||
      character === "<" ||
      character === "*" ||
      character === "_" ||
      character === "[" ||
      (options.gfmExtensions && character === "~") ||
      (options.mathExtensions && character === "$") ||
      (options.allowImages &&
        character === "!" &&
        (text[index + 1] ?? "") === "[")
    ) {
      return false;
    }
  }

  return true;
}

function getDelimiterLookbehindStart(
  text: string,
  stablePrefixLength: number,
): number | undefined {
  if (stablePrefixLength === 0) {
    return undefined;
  }

  const previousCharacter = getCharacterBefore(text, stablePrefixLength);

  if (
    previousCharacter === undefined ||
    isWhitespaceCharacter(previousCharacter) ||
    isPunctuationCharacter(previousCharacter)
  ) {
    return undefined;
  }

  return getCharacterStartBefore(text, stablePrefixLength);
}

function getLiteralAutolinkContinuationStart(
  text: string,
  stablePrefixLength: number,
  options: InlineParseOptions,
): number | undefined {
  if (
    stablePrefixLength === 0 ||
    !options.gfmExtensions ||
    !options.allowLinks
  ) {
    return undefined;
  }

  const literalAutolinkStart = findTrailingLiteralAutolinkCandidateStart(
    text,
    0,
  );

  if (
    literalAutolinkStart === undefined ||
    literalAutolinkStart >= stablePrefixLength ||
    isInlineLinkDestinationLiteralAutolinkCandidate(text, literalAutolinkStart)
  ) {
    return undefined;
  }

  return isPlainTextLiteralAutolinkContinuationSegment(
    text,
    literalAutolinkStart,
    stablePrefixLength,
    options,
  )
    ? literalAutolinkStart
    : undefined;
}

function isInlineLinkDestinationLiteralAutolinkCandidate(
  text: string,
  startIndex: number,
): boolean {
  if (text[startIndex - 1] === "(" && text[startIndex - 2] === "]") {
    return true;
  }

  return (
    text[startIndex - 1] === "<" &&
    text[startIndex - 2] === "(" &&
    text[startIndex - 3] === "]"
  );
}

function createInlineAppendContinuation(
  text: string,
  stablePrefixLength: number,
  options: InlineParseOptions,
): InternalInlineAppendContinuation | undefined {
  if (stablePrefixLength === 0) {
    return undefined;
  }

  const delimiterLookbehindStart = getDelimiterLookbehindStart(
    text,
    stablePrefixLength,
  );
  const literalAutolinkStart = getLiteralAutolinkContinuationStart(
    text,
    stablePrefixLength,
    options,
  );

  if (
    delimiterLookbehindStart === undefined &&
    literalAutolinkStart === undefined
  ) {
    return undefined;
  }

  return {
    delimiterLookbehindStart,
    literalAutolinkStart,
  };
}

function isDelimiterContinuationCharacter(
  character: string | undefined,
  options: InlineParseOptions,
): boolean {
  return (
    character === "*" ||
    character === "_" ||
    (options.gfmExtensions && character === "~")
  );
}

function getInlineAppendContinuationStart(
  text: string,
  options: InlineParseOptions,
  previousCache: InternalInlineCache,
): number {
  const { appendContinuation, stablePrefixLength } = previousCache;

  if (appendContinuation === undefined) {
    return stablePrefixLength;
  }

  let continuationStart = stablePrefixLength;
  const firstSuffixCharacter =
    stablePrefixLength < previousCache.text.length
      ? getCharacterAfter(previousCache.text, stablePrefixLength)
      : getCharacterAfter(text, previousCache.text.length);

  if (
    appendContinuation.delimiterLookbehindStart !== undefined &&
    isDelimiterContinuationCharacter(firstSuffixCharacter, options)
  ) {
    continuationStart = Math.min(
      continuationStart,
      appendContinuation.delimiterLookbehindStart,
    );
  }

  const firstAppendedCharacter = getCharacterAfter(
    text,
    previousCache.text.length,
  );

  if (
    appendContinuation.literalAutolinkStart !== undefined &&
    firstAppendedCharacter !== undefined &&
    !isLiteralAutolinkTerminator(firstAppendedCharacter) &&
    shouldContinueLiteralAutolinkCandidate(
      text,
      appendContinuation.literalAutolinkStart,
    )
  ) {
    continuationStart = Math.min(
      continuationStart,
      appendContinuation.literalAutolinkStart,
    );
  }

  return continuationStart;
}

function shouldContinueLiteralAutolinkCandidate(
  text: string,
  startIndex: number,
): boolean {
  if (isPotentialUriLiteralAutolinkPrefix(text, startIndex, text.length)) {
    return true;
  }

  if (!isPotentialEmailLiteralPrefix(text, startIndex, text.length)) {
    return false;
  }

  for (let index = startIndex; index < text.length; index += 1) {
    const character = text[index];

    if (isLiteralAutolinkTerminator(character)) {
      return false;
    }

    if (character === "@") {
      return true;
    }
  }

  return false;
}

function createInlineCacheFromParsedChildren(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
  parsed: ParsedInlineChildren,
): InternalInlineCache {
  let stablePrefixLength = parsed.appendSafeOffset;
  let stablePrefixChildren =
    stablePrefixLength === text.length
      ? parsed.children
      : createStablePrefixChildren(
          text,
          stablePrefixLength,
          options,
          definitions,
          definitionIndex,
          footnoteDefinitions,
          footnoteDefinitionIndex,
        );

  if (stablePrefixLength > 0 && stablePrefixLength < text.length) {
    const mergedExactChildren = mergeInlineChildren(
      stablePrefixChildren,
      createInlineChildren(
        text.slice(stablePrefixLength),
        options,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
      ),
    );

    if (!arePhrasingChildrenEqual(parsed.children, mergedExactChildren)) {
      stablePrefixLength = 0;
      stablePrefixChildren = [];
    }
  }

  stablePrefixChildren = shareStablePrefixChildReferences(
    stablePrefixChildren,
    parsed.children,
  );

  const optimisticChildren = createOptimisticInlineChildren(
    text,
    parsed.unresolvedStart,
    stablePrefixChildren,
    stablePrefixLength,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    parsed.children,
  );

  return {
    appendContinuation: createInlineAppendContinuation(
      text,
      stablePrefixLength,
      options,
    ),
    children: parsed.children,
    definitions,
    footnoteDefinitions,
    optimisticChildren,
    resumeState:
      parsed.resumeState !== undefined &&
      parsed.appendSensitiveStart === undefined
        ? parsed.resumeState
        : undefined,
    stablePrefixChildren,
    stablePrefixLength,
    text,
  };
}

function createFullInlineCache(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
): InternalInlineCache {
  const parsed = parseInlineChildren(
    text,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
  );

  return createInlineCacheFromParsedChildren(
    text,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    parsed,
  );
}

function createExactInlineCache(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
): InternalInlineCache {
  const parsed = parseInlineChildren(
    text,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
  );

  return {
    children: parsed.children,
    definitions,
    footnoteDefinitions,
    stablePrefixChildren: parsed.children,
    stablePrefixLength: text.length,
    text,
  };
}

function appendBracketInlineCache(
  text: string,
  options: InlineParseOptions,
  definitions: readonly InternalLinkReferenceDefinition[],
  definitionIndex:
    | ReadonlyMap<string, InternalLinkReferenceDefinition>
    | undefined,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[],
  footnoteDefinitionIndex:
    | ReadonlyMap<string, InternalFootnoteReferenceDefinition>
    | undefined,
  previousCache: InternalInlineCache,
  resumeState: BracketInlineResumeState,
): InternalInlineCache {
  const { state } = resumeState;
  const previousTextLength = state.text.length;

  state.text = text;
  state.appendSensitiveStart = undefined;
  state.definitions = definitions;
  state.definitionIndex = definitionIndex;
  state.footnoteDefinitions = footnoteDefinitions;
  state.footnoteDefinitionIndex = footnoteDefinitionIndex;

  if (state.tail !== state.root) {
    markProjectionDirtyFromNode(state, state.tail);
  }

  const scanned = scanInline(
    text,
    options,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    {
      appendText(value: string): void {
        appendTextToMutableInlineParserState(state, value);
      },
      appendNode(node: PhrasingContent): void {
        appendNodeToMutableInlineParserState(state, node);
      },
      appendDelimiter(token: InlineDelimiterToken): void {
        const node = appendTextToMutableInlineParserState(
          state,
          token.marker.repeat(token.length),
          false,
        );

        pushDelimiterEntry(state, node, token);
      },
      openBracket(labelStartIndex: number, image: boolean): void {
        const node = appendTextToMutableInlineParserState(
          state,
          image ? "![" : "[",
          false,
        );

        addBracketEntry(state, node, labelStartIndex, image);
      },
      closeBracket(closeBracketIndex: number): number {
        return resolveBracketCloser(state, closeBracketIndex);
      },
    },
    true,
    previousTextLength,
  );

  const parsed = finalizeBracketInlineState(
    state,
    scanned.unresolvedStart,
    scanned.appendSensitiveStart,
  );
  const stablePrefixLength = parsed.appendSafeOffset;
  let stablePrefixChildren: PhrasingContent[];

  if (stablePrefixLength === text.length) {
    stablePrefixChildren = parsed.children;
  } else if (stablePrefixLength === previousCache.stablePrefixLength) {
    stablePrefixChildren = previousCache.stablePrefixChildren;
  } else if (
    stablePrefixLength > previousCache.stablePrefixLength &&
    previousCache.stablePrefixLength > 0
  ) {
    stablePrefixChildren = mergeInlineChildren(
      previousCache.stablePrefixChildren,
      createInlineChildrenPreservingTrailingWhitespace(
        text.slice(previousCache.stablePrefixLength, stablePrefixLength),
        options,
        definitions,
        definitionIndex,
        footnoteDefinitions,
        footnoteDefinitionIndex,
      ),
    );
  } else {
    stablePrefixChildren = createStablePrefixChildren(
      text,
      stablePrefixLength,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );
  }

  stablePrefixChildren = shareStablePrefixChildReferences(
    stablePrefixChildren,
    parsed.children,
  );

  const optimisticChildren = createOptimisticInlineChildren(
    text,
    parsed.unresolvedStart,
    stablePrefixChildren,
    stablePrefixLength,
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
    parsed.children,
  );

  return {
    appendContinuation: createInlineAppendContinuation(
      text,
      stablePrefixLength,
      options,
    ),
    children: parsed.children,
    definitions,
    footnoteDefinitions,
    optimisticChildren,
    resumeState:
      parsed.unresolvedStart !== undefined &&
      parsed.explicitUnresolvedStart === undefined &&
      parsed.appendSensitiveStart === undefined
        ? resumeState
        : undefined,
    stablePrefixChildren,
    stablePrefixLength,
    text,
  };
}

export function createInlineCache(
  text: string,
  options: InlineParseOptions = DEFAULT_INLINE_PARSE_OPTIONS,
  definitions: readonly InternalLinkReferenceDefinition[] = [],
  definitionIndex?: ReadonlyMap<string, InternalLinkReferenceDefinition>,
  footnoteDefinitions: readonly InternalFootnoteReferenceDefinition[] = [],
  footnoteDefinitionIndex?: ReadonlyMap<
    string,
    InternalFootnoteReferenceDefinition
  >,
  previousCache?: InternalInlineCache,
  allowContinuation = true,
  knownAppend = false,
): InternalInlineCache {
  if (!allowContinuation) {
    return createExactInlineCache(
      text,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );
  }

  if (
    previousCache === undefined ||
    previousCache.definitions !== definitions ||
    previousCache.footnoteDefinitions !== footnoteDefinitions ||
    text.length < previousCache.text.length ||
    (!knownAppend && !text.startsWith(previousCache.text))
  ) {
    return createFullInlineCache(
      text,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );
  }

  if (isBracketInlineResumeState(previousCache.resumeState)) {
    return appendBracketInlineCache(
      text,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
      previousCache,
      previousCache.resumeState,
    );
  }

  if (previousCache.stablePrefixLength === 0) {
    return createFullInlineCache(
      text,
      options,
      definitions,
      definitionIndex,
      footnoteDefinitions,
      footnoteDefinitionIndex,
    );
  }

  const continuationStart = getInlineAppendContinuationStart(
    text,
    options,
    previousCache,
  );
  const stablePrefixLength = previousCache.stablePrefixLength;

  if (
    continuationStart === previousCache.text.length &&
    stablePrefixLength === previousCache.text.length
  ) {
    const appendedText = text.slice(previousCache.text.length);

    const canAppendPlainText =
      appendedText.length === 1
        ? appendedText !== " " &&
          appendedText !== "\t" &&
          appendedText !== "\n" &&
          appendedText !== "\\" &&
          appendedText !== "`" &&
          appendedText !== "&" &&
          appendedText !== "<" &&
          appendedText !== "*" &&
          appendedText !== "_" &&
          appendedText !== "[" &&
          appendedText !== "@" &&
          (!options.allowImages || appendedText !== "!") &&
          (!options.gfmExtensions || appendedText !== "~") &&
          (!options.mathExtensions || appendedText !== "$")
        : canUseSingleLinePlainInlineFastPath(appendedText, options);

    if (canAppendPlainText) {
      const previousChildren = previousCache.children;
      const previousLastChild = previousChildren[previousChildren.length - 1];
      const children =
        previousLastChild?.type === "text"
          ? previousChildren.length === 1
            ? [createText(previousLastChild.value + appendedText)]
            : [
                ...previousChildren.slice(0, -1),
                createText(previousLastChild.value + appendedText),
              ]
          : [...previousChildren, createText(appendedText)];

      return {
        appendContinuation: createInlineAppendContinuation(
          text,
          text.length,
          options,
        ),
        children,
        definitions,
        footnoteDefinitions,
        stablePrefixChildren: children,
        stablePrefixLength: text.length,
        text,
      };
    }
  }

  const stablePrefixChildren =
    continuationStart === stablePrefixLength
      ? previousCache.stablePrefixChildren
      : createStablePrefixChildren(
          text,
          continuationStart,
          options,
          definitions,
          definitionIndex,
          footnoteDefinitions,
          footnoteDefinitionIndex,
        );
  const suffixCache = createFullInlineCache(
    text.slice(continuationStart),
    options,
    definitions,
    definitionIndex,
    footnoteDefinitions,
    footnoteDefinitionIndex,
  );
  const mergedChildren = mergeInlineChildren(
    stablePrefixChildren,
    suffixCache.children,
  );
  const mergedStablePrefixChildren =
    suffixCache.children === suffixCache.stablePrefixChildren
      ? mergedChildren
      : mergeInlineChildren(
          stablePrefixChildren,
          suffixCache.stablePrefixChildren,
        );

  return {
    appendContinuation: createInlineAppendContinuation(
      text,
      continuationStart + suffixCache.stablePrefixLength,
      options,
    ),
    children: mergedChildren,
    definitions,
    footnoteDefinitions,
    optimisticChildren: suffixCache.optimisticChildren
      ? mergeInlineChildren(
          stablePrefixChildren,
          suffixCache.optimisticChildren,
        )
      : undefined,
    stablePrefixChildren: mergedStablePrefixChildren,
    stablePrefixLength: continuationStart + suffixCache.stablePrefixLength,
    text,
  };
}
