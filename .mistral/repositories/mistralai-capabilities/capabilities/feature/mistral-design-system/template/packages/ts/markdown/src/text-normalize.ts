function foldReferenceLabelCase(value: string): string {
  return value.toLowerCase().replaceAll("ß", "ss");
}

export function isEscapablePunctuation(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  switch (character) {
    case "!":
    case '"':
    case "#":
    case "$":
    case "%":
    case "&":
    case "'":
    case "(":
    case ")":
    case "*":
    case "+":
    case ",":
    case "-":
    case ".":
    case "/":
    case ":":
    case ";":
    case "<":
    case "=":
    case ">":
    case "?":
    case "@":
    case "[":
    case "\\":
    case "]":
    case "^":
    case "_":
    case "`":
    case "{":
    case "|":
    case "}":
    case "~":
      return true;
    default:
      return false;
  }
}

export function decodeEscapablePunctuation(value: string): string {
  let decoded = "";
  let index = 0;

  while (index < value.length) {
    const character = value[index] ?? "";
    const nextCharacter = value[index + 1];

    if (
      character === "\\" &&
      nextCharacter !== undefined &&
      isEscapablePunctuation(nextCharacter)
    ) {
      decoded += nextCharacter;
      index += 2;
      continue;
    }

    decoded += character;
    index += 1;
  }

  return decoded;
}

export function normalizeReferenceLabel(value: string): string {
  let normalized = "";
  let pendingSpace = false;

  for (let index = 0; index < value.length; index += 1) {
    const character = value[index] ?? "";

    if (
      character === " " ||
      character === "\t" ||
      character === "\n" ||
      character === "\r"
    ) {
      pendingSpace = normalized.length > 0;
      continue;
    }

    if (pendingSpace) {
      normalized += " ";
      pendingSpace = false;
    }

    normalized += character;
  }

  return foldReferenceLabelCase(normalized);
}

export function containsBlankLine(value: string): boolean {
  let sawLineEnding = false;
  let index = 0;

  while (index < value.length) {
    const character = value[index] ?? "";

    if (character === "\r") {
      index += value[index + 1] === "\n" ? 2 : 1;

      if (sawLineEnding) {
        return true;
      }

      sawLineEnding = true;
      continue;
    }

    if (character === "\n") {
      index += 1;

      if (sawLineEnding) {
        return true;
      }

      sawLineEnding = true;
      continue;
    }

    if (sawLineEnding && (character === " " || character === "\t")) {
      index += 1;
      continue;
    }

    sawLineEnding = false;
    index += 1;
  }

  return false;
}

export function containsLineEnding(
  value: string,
  startIndex = 0,
  endIndex = value.length,
): boolean {
  for (let index = startIndex; index < endIndex; index += 1) {
    const character = value[index];

    if (character === "\n" || character === "\r") {
      return true;
    }
  }

  return false;
}
