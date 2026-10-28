type HtmlTagStart = {
  readonly closing: boolean;
  readonly name: string;
};

function isAsciiLetter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
}

function isAsciiUpper(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return code >= 0x41 && code <= 0x5a;
}

function isAsciiAlphaNumericOrHyphen(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    character === "-" ||
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isHtmlWhitespace(character: string | undefined): boolean {
  return (
    character === " " ||
    character === "\t" ||
    character === "\n" ||
    character === "\r" ||
    character === "\f"
  );
}

function isHtmlAttributeNameStart(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    character === ":" ||
    character === "_" ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function isHtmlAttributeNameCharacter(character: string | undefined): boolean {
  if (character === undefined) {
    return false;
  }

  const code = character.charCodeAt(0);

  return (
    character === ":" ||
    character === "_" ||
    character === "." ||
    character === "-" ||
    (code >= 0x30 && code <= 0x39) ||
    (code >= 0x41 && code <= 0x5a) ||
    (code >= 0x61 && code <= 0x7a)
  );
}

function skipHtmlWhitespace(text: string, startIndex: number): number {
  let index = startIndex;

  while (isHtmlWhitespace(text[index])) {
    index += 1;
  }

  return index;
}

function scanHtmlTagName(text: string, startIndex: number): number | null {
  if (!isAsciiLetter(text[startIndex])) {
    return null;
  }

  let index = startIndex + 1;

  while (isAsciiAlphaNumericOrHyphen(text[index])) {
    index += 1;
  }

  return index;
}

function scanHtmlAttributeName(
  text: string,
  startIndex: number,
): number | null {
  if (!isHtmlAttributeNameStart(text[startIndex])) {
    return null;
  }

  let index = startIndex + 1;

  while (index < text.length) {
    const character = text[index];

    if (
      character === undefined ||
      character === "/" ||
      character === ">" ||
      character === "=" ||
      isHtmlWhitespace(character)
    ) {
      break;
    }

    if (!isHtmlAttributeNameCharacter(character)) {
      return null;
    }

    index += 1;
  }

  return index;
}

function scanHtmlAttributeValue(
  text: string,
  startIndex: number,
): number | null {
  const opener = text[startIndex];

  if (opener === '"') {
    let index = startIndex + 1;

    while (index < text.length && text[index] !== '"') {
      index += 1;
    }

    return text[index] === '"' ? index + 1 : null;
  }

  if (opener === "'") {
    let index = startIndex + 1;

    while (index < text.length && text[index] !== "'") {
      index += 1;
    }

    return text[index] === "'" ? index + 1 : null;
  }

  let index = startIndex;

  while (index < text.length) {
    const character = text[index];

    if (character === undefined || isHtmlWhitespace(character)) {
      break;
    }

    if (
      character === '"' ||
      character === "'" ||
      character === "=" ||
      character === "<" ||
      character === ">" ||
      character === "`"
    ) {
      return null;
    }

    index += 1;
  }

  return index === startIndex ? null : index;
}

export function parseHtmlTagStart(
  text: string,
  startIndex = 0,
): HtmlTagStart | null {
  if (text[startIndex] !== "<") {
    return null;
  }

  const closing = text[startIndex + 1] === "/";
  const nameStartIndex = startIndex + (closing ? 2 : 1);
  const nameEndIndex = scanHtmlTagName(text, nameStartIndex);

  if (nameEndIndex === null) {
    return null;
  }

  const afterName = text[nameEndIndex];

  if (
    afterName !== undefined &&
    afterName !== ">" &&
    afterName !== "/" &&
    !isHtmlWhitespace(afterName)
  ) {
    return null;
  }

  return {
    closing,
    name: text.slice(nameStartIndex, nameEndIndex).toLowerCase(),
  };
}

export function isHtmlDeclarationStart(text: string, startIndex = 0): boolean {
  return (
    text[startIndex] === "<" &&
    text[startIndex + 1] === "!" &&
    isAsciiUpper(text[startIndex + 2])
  );
}

export function scanCompleteOpeningHtmlTag(
  text: string,
  startIndex = 0,
): number | null {
  if (text[startIndex] !== "<" || text[startIndex + 1] === "/") {
    return null;
  }

  let index = scanHtmlTagName(text, startIndex + 1);

  if (index === null) {
    return null;
  }

  while (index < text.length) {
    const nextIndex = skipHtmlWhitespace(text, index);

    if (text[nextIndex] === ">") {
      return nextIndex + 1;
    }

    if (text[nextIndex] === "/" && text[nextIndex + 1] === ">") {
      return nextIndex + 2;
    }

    if (nextIndex === index) {
      return null;
    }

    const attributeNameEnd = scanHtmlAttributeName(text, nextIndex);

    if (attributeNameEnd === null) {
      return null;
    }

    const afterAttributeName = skipHtmlWhitespace(text, attributeNameEnd);

    if (text[afterAttributeName] !== "=") {
      index = attributeNameEnd;
      continue;
    }

    index = skipHtmlWhitespace(text, afterAttributeName + 1);

    const attributeValueEnd = scanHtmlAttributeValue(text, index);

    if (attributeValueEnd === null) {
      return null;
    }

    index = attributeValueEnd;
  }

  return null;
}

export function scanCompleteClosingHtmlTag(
  text: string,
  startIndex = 0,
): number | null {
  if (text[startIndex] !== "<" || text[startIndex + 1] !== "/") {
    return null;
  }

  const nameEndIndex = scanHtmlTagName(text, startIndex + 2);

  if (nameEndIndex === null) {
    return null;
  }

  const index = skipHtmlWhitespace(text, nameEndIndex);

  return text[index] === ">" ? index + 1 : null;
}

export function scanCompleteHtmlTag(
  text: string,
  startIndex = 0,
): number | null {
  return text[startIndex + 1] === "/"
    ? scanCompleteClosingHtmlTag(text, startIndex)
    : scanCompleteOpeningHtmlTag(text, startIndex);
}
