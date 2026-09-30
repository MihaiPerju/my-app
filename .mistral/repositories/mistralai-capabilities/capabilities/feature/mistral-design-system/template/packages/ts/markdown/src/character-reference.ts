const NAMED_CHARACTER_REFERENCES = {
  AElig: "Æ",
  ClockwiseContourIntegral: "∲",
  Dcaron: "Ď",
  DifferentialD: "ⅆ",
  HilbertSpace: "ℋ",
  amp: "&",
  apos: "'",
  auml: "ä",
  copy: "©",
  frac34: "¾",
  gt: ">",
  lt: "<",
  nbsp: "\u00A0",
  ngE: "≧̸",
  ouml: "ö",
  quot: '"',
} as const;

type CharacterReference =
  | {
      readonly endIndex: number;
      readonly kind: "decimal";
      readonly value: string;
    }
  | {
      readonly endIndex: number;
      readonly kind: "hexadecimal";
      readonly value: string;
    }
  | {
      readonly endIndex: number;
      readonly kind: "named";
      readonly value: string;
    };

function isAsciiDigit(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return code >= 0x30 && code <= 0x39;
}

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiAlphaNumeric(character: string | undefined): boolean {
  return isAsciiLetter(character) || isAsciiDigit(character);
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

function normalizeCharacterReferenceCodePoint(codePoint: number): number {
  if (
    !Number.isFinite(codePoint) ||
    codePoint <= 0 ||
    codePoint > 0x10ffff ||
    (codePoint >= 0xd800 && codePoint <= 0xdfff)
  ) {
    return 0xfffd;
  }

  return codePoint;
}

function scanCharacterReference(
  value: string,
  startIndex: number,
): CharacterReference | null {
  if (value[startIndex] !== "&") {
    return null;
  }

  let index = startIndex + 1;

  if (value[index] === "#") {
    index += 1;

    const hexadecimal = value[index] === "x" || value[index] === "X";

    if (hexadecimal) {
      index += 1;

      const digitsStart = index;

      while (index - digitsStart < 6 && isHexDigit(value[index])) {
        index += 1;
      }

      if (index === digitsStart || value[index] !== ";") {
        return null;
      }

      return {
        endIndex: index + 1,
        kind: "hexadecimal",
        value: value.slice(digitsStart, index),
      };
    }

    const digitsStart = index;

    while (index - digitsStart < 7 && isAsciiDigit(value[index])) {
      index += 1;
    }

    if (index === digitsStart || value[index] !== ";") {
      return null;
    }

    return {
      endIndex: index + 1,
      kind: "decimal",
      value: value.slice(digitsStart, index),
    };
  }

  if (!isAsciiLetter(value[index])) {
    return null;
  }

  const nameStart = index;

  index += 1;

  while (index - nameStart < 32 && isAsciiAlphaNumeric(value[index])) {
    index += 1;
  }

  if (value[index] !== ";") {
    return null;
  }

  return {
    endIndex: index + 1,
    kind: "named",
    value: value.slice(nameStart, index),
  };
}

function decodeCharacterReference(
  value: string,
  startIndex: number,
  reference: CharacterReference,
): string {
  if (reference.kind === "decimal") {
    return String.fromCodePoint(
      normalizeCharacterReferenceCodePoint(
        Number.parseInt(reference.value, 10),
      ),
    );
  }

  if (reference.kind === "hexadecimal") {
    return String.fromCodePoint(
      normalizeCharacterReferenceCodePoint(
        Number.parseInt(reference.value, 16),
      ),
    );
  }

  return (
    NAMED_CHARACTER_REFERENCES[
      reference.value as keyof typeof NAMED_CHARACTER_REFERENCES
    ] ?? value.slice(startIndex, reference.endIndex)
  );
}

export function matchCharacterReference(
  value: string,
  startIndex: number,
): string | null {
  const reference = scanCharacterReference(value, startIndex);

  return reference === null
    ? null
    : value.slice(startIndex, reference.endIndex);
}

export function matchTrailingCharacterReference(
  value: string,
  endIndex = value.length,
): string | null {
  if (endIndex <= 0 || value[endIndex - 1] !== ";") {
    return null;
  }

  const ampersandIndex = value.lastIndexOf("&", endIndex - 1);

  if (ampersandIndex === -1) {
    return null;
  }

  const match = matchCharacterReference(value, ampersandIndex);

  return match !== null && ampersandIndex + match.length === endIndex
    ? match
    : null;
}

export function decodeCharacterReferences(value: string): string {
  let decoded = "";
  let index = 0;

  while (index < value.length) {
    const reference = scanCharacterReference(value, index);

    if (reference !== null) {
      decoded += decodeCharacterReference(value, index, reference);
      index = reference.endIndex;
      continue;
    }

    decoded += value[index] ?? "";
    index += 1;
  }

  return decoded;
}
