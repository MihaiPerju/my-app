import type { SpecExample } from "./types.js";

const EXAMPLE_SEPARATOR = ".";
const EXAMPLE_CLOSE = "`".repeat(32);
const EXAMPLE_OPEN_PREFIX = `${EXAMPLE_CLOSE} example`;
const END_TESTS_MARKER = "<!-- END TESTS -->";

function normalizeLineEndings(text: string): string {
  let normalized = "";

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index] ?? "";

    if (character === "\r") {
      if (text[index + 1] === "\n") {
        index += 1;
      }

      normalized += "\n";
      continue;
    }

    normalized += character;
  }

  return normalized;
}

function normalizeSpecText(text: string): string {
  const normalizedText = normalizeLineEndings(text);

  if (normalizedText.startsWith(END_TESTS_MARKER)) {
    return "";
  }

  const markerIndex = normalizedText.indexOf(`\n${END_TESTS_MARKER}`);

  return markerIndex === -1
    ? normalizedText
    : normalizedText.slice(0, markerIndex + 1);
}

function withTabs(value: string): string {
  return value.replaceAll("→", "\t");
}

function isAsciiWhitespace(character: string | undefined): boolean {
  return character === " " || character === "\t";
}

function parseHeaderLine(line: string): string | null {
  let index = 0;

  while (index < 6 && line[index] === "#") {
    index += 1;
  }

  if (index === 0 || !isAsciiWhitespace(line[index])) {
    return null;
  }

  while (isAsciiWhitespace(line[index])) {
    index += 1;
  }

  return line.slice(index);
}

function splitAsciiWhitespace(value: string): string[] {
  const segments: string[] = [];
  let startIndex = -1;

  for (let index = 0; index <= value.length; index += 1) {
    const character = value[index];

    if (character !== undefined && !isAsciiWhitespace(character)) {
      if (startIndex === -1) {
        startIndex = index;
      }

      continue;
    }

    if (startIndex !== -1) {
      segments.push(value.slice(startIndex, index));
      startIndex = -1;
    }
  }

  return segments;
}

function parseExampleOpenExtensions(line: string): string[] | null {
  if (!line.startsWith(EXAMPLE_OPEN_PREFIX)) {
    return null;
  }

  if (line.length === EXAMPLE_OPEN_PREFIX.length) {
    return [];
  }

  if (!isAsciiWhitespace(line[EXAMPLE_OPEN_PREFIX.length])) {
    return null;
  }

  return splitAsciiWhitespace(line.slice(EXAMPLE_OPEN_PREFIX.length).trim());
}

export function parseSpecExamples(
  text: string,
  options: {
    suite: string;
    sourcePath?: string;
  },
): SpecExample[] {
  const normalizedText: string = normalizeSpecText(text);
  const rawLines: string[] = normalizedText.split("\n");
  const examples: SpecExample[] = [];

  let currentSection = "";
  let currentExampleNumber = 0;
  let currentState: "regular" | "markdown" | "html" = "regular";
  let currentStartLine = 0;
  let currentExtensions: string[] = [];
  let markdownLines: string[] = [];
  let htmlLines: string[] = [];

  for (const [index, rawLineWithoutNewline] of rawLines.entries()) {
    const lineNumber: number = index + 1;
    const hasTrailingNewline: boolean = index < rawLines.length - 1;
    const rawLine: string = hasTrailingNewline
      ? `${rawLineWithoutNewline}\n`
      : rawLineWithoutNewline;
    const trimmedLine: string = rawLine.trim();

    if (currentState === "regular") {
      const header = parseHeaderLine(rawLineWithoutNewline);

      if (header !== null) {
        currentSection = header.trim();
        continue;
      }

      const extensions = parseExampleOpenExtensions(trimmedLine);

      if (extensions !== null) {
        currentState = "markdown";
        currentStartLine = 0;
        currentExtensions = extensions;
      }

      continue;
    }

    if (currentState === "markdown") {
      if (trimmedLine === EXAMPLE_SEPARATOR) {
        currentState = "html";
        continue;
      }

      if (currentStartLine === 0) {
        currentStartLine = lineNumber - 1;
      }

      markdownLines.push(rawLine);
      continue;
    }

    if (trimmedLine === EXAMPLE_CLOSE) {
      currentExampleNumber += 1;

      examples.push({
        suite: options.suite,
        number: currentExampleNumber,
        section: currentSection,
        startLine: currentStartLine,
        endLine: lineNumber,
        markdown: withTabs(markdownLines.join("")),
        html: withTabs(htmlLines.join("")),
        extensions: currentExtensions,
        sourcePath: options.sourcePath,
      });

      currentState = "regular";
      currentStartLine = 0;
      currentExtensions = [];
      markdownLines = [];
      htmlLines = [];
      continue;
    }

    htmlLines.push(rawLine);
  }

  return examples;
}
