type Literal = null | boolean | number | string;

export type JSONValue = object | unknown[] | Literal;

type ParserScope =
  | { type: "global"; current?: Literal }
  | { type: "array"; current: unknown[] }
  | { type: "object"; key: string; current: Record<string, unknown> };

/**
 * Incremental JSON stream parser for partial payloads (e.g. LLM output).
 *
 * Feeds a tokenizer and applies events to a stable object tree, so it never
 * re-parses already processed text and can emit partial string updates as they
 * grow. This keeps types stable at each JSON position while streaming.
 *
 * Note: invalid JSON error will throw an error.
 */
export class JSONStreamParser {
  private tokenizer = new JSONStreamTokenizer();
  private stack: ParserScope[] = [];
  private currentScope: ParserScope = { type: "global" };

  write(jsonStr: string) {
    const events = this.tokenizer.write(jsonStr);
    this.processEvents(events);
  }

  end(): JSONValue {
    const events = this.tokenizer.end();
    this.processEvents(events);
    return this.getCurrentValue();
  }

  getCurrentValue(): JSONValue {
    const currentValue =
      this.stack.length > 0
        ? // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
          this.stack[0]!.current
        : this.currentScope.current;
    return structuredClone(currentValue ?? null);
  }

  private processEvents(events: JSONParseToken[]) {
    for (const event of events) {
      switch (event.type) {
        case "startObject": {
          const newObj = {};
          if (this.currentScope.type === "array") {
            this.currentScope.current.push(newObj);
            this.stack.push(this.currentScope);
          } else if (this.currentScope.type === "object") {
            this.currentScope.current[this.currentScope.key] = newObj;
            this.stack.push(this.currentScope);
          }
          this.currentScope = { type: "object", key: "", current: newObj };
          break;
        }
        case "startArray": {
          const newArr: unknown[] = [];
          if (this.currentScope.type === "array") {
            this.currentScope.current.push(newArr);
            this.stack.push(this.currentScope);
          } else if (this.currentScope.type === "object") {
            this.currentScope.current[this.currentScope.key] = newArr;
            this.stack.push(this.currentScope);
          }
          this.currentScope = { type: "array", current: newArr };
          break;
        }
        case "endObject":
        case "endArray": {
          this.currentScope = this.stack.pop() || this.currentScope;
          break;
        }
        case "key": {
          if (this.currentScope.type === "object") {
            this.currentScope.key = event.value;
          }
          break;
        }
        case "value_start": {
          if (this.currentScope.type === "array") {
            this.currentScope.current.push(event.value);
          } else if (this.currentScope.type === "object") {
            this.currentScope.current[this.currentScope.key] = event.value;
          } else {
            // global scope
            this.currentScope.current = event.value;
          }
          break;
        }
        case "value_update": {
          if (this.currentScope.type === "array") {
            setLast(this.currentScope.current, event.value);
          } else if (this.currentScope.type === "object") {
            this.currentScope.current[this.currentScope.key] = event.value;
          } else {
            // global scope
            this.currentScope.current = event.value;
          }
          break;
        }
        case "value_complete": {
          if (this.currentScope.type === "array") {
            setLast(this.currentScope.current, event.value);
          } else if (this.currentScope.type === "object") {
            this.currentScope.current[this.currentScope.key] = event.value;
            this.currentScope.key = "";
          } else {
            // global scope
            this.currentScope.current = event.value;
          }
          break;
        }
      }
    }
  }
}

export const setLast = <T>(array: T[], value: T): void => {
  if (array.length === 0) {
    throw new Error("setLast called on empty array");
  }
  array[array.length - 1] = value;
};

export type JSONParseToken =
  | { type: "startObject" }
  | { type: "endObject" }
  | { type: "startArray" }
  | { type: "endArray" }
  | { type: "key"; value: string }
  | { type: "value_start"; value: Literal }
  | { type: "value_update"; value: Literal }
  | { type: "value_complete"; value: Literal };

const tokenStartObject = { type: "startObject" } satisfies JSONParseToken;
const tokenEndObject = { type: "endObject" } satisfies JSONParseToken;
const tokenStartArray = { type: "startArray" } satisfies JSONParseToken;
const tokenEndArray = { type: "endArray" } satisfies JSONParseToken;

type TokenizerScope =
  | { type: "global"; inValue: boolean }
  | { type: "array" }
  | { type: "object"; inValue: boolean };

type ValueContext =
  | {
      type: "string";
      buffer: string;
      parser: UnicodeStreamParser;
      isComplete: boolean;
    }
  | { type: "literal"; buffer: string };

export class JSONStreamTokenizer {
  private valueContext: ValueContext | null = null;
  private lastEmittedStringValueUpdate: string | null = null;
  private stack: TokenizerScope[] = [];
  private currentScope: TokenizerScope = { type: "global", inValue: false };

  get isInStringValue(): boolean {
    return (
      this.valueContext?.type === "string" &&
      ((this.currentScope.type === "object" && this.currentScope.inValue) ||
        this.currentScope.type === "array" ||
        this.currentScope.type === "global")
    );
  }

  private assertCanStartValue(char: string): void {
    if (this.currentScope.type === "global" && this.currentScope.inValue) {
      throw new Error(`Invalid JSON: unexpected '${char}' after value`);
    }
    if (this.currentScope.type === "object" && !this.currentScope.inValue) {
      // In an object, expecting a key, but got a value-starting character
      if (char !== '"') {
        throw new Error(`Invalid JSON: expected a key, got '${char}'`);
      }
    }
    if (this.currentScope.type === "global") {
      this.currentScope.inValue = true;
    }
  }

  write(jsonStr: string): JSONParseToken[] {
    let events: JSONParseToken[] = [];
    for (const char of jsonStr) {
      if (
        this.valueContext?.type === "string" &&
        !this.valueContext.isComplete
      ) {
        const isEndOfString =
          !this.valueContext.parser.isEscaping && char === '"';
        if (isEndOfString) {
          this.valueContext.buffer = this.valueContext.parser.end();
          this.valueContext.isComplete = true;
        } else {
          this.valueContext.buffer = this.valueContext.parser.write(char);
        }

        const maybeEvent = this.maybeEmitValueUpdate(this.valueContext.buffer);
        if (maybeEvent) events = appendEvent(events, maybeEvent);
        continue;
      }

      switch (char) {
        case "{": {
          this.assertCanStartValue("{");
          events = appendEvent(events, tokenStartObject);
          this.stack.push(this.currentScope);
          this.currentScope = { type: "object", inValue: false };
          break;
        }
        case "}": {
          if (this.currentScope.type !== "object") {
            throw new Error(`Invalid JSON: unexpected '}'`);
          }
          if (this.valueContext) {
            events = appendEvent(events, ...this.emitValueComplete());
          }
          events = appendEvent(events, tokenEndObject);
          this.currentScope = this.stack.pop() ?? {
            type: "global",
            inValue: false,
          };
          break;
        }
        case "[": {
          this.assertCanStartValue("[");
          events = appendEvent(events, tokenStartArray);
          this.stack.push(this.currentScope);
          this.currentScope = { type: "array" };
          break;
        }
        case "]": {
          if (this.currentScope.type !== "array") {
            throw new Error(`Invalid JSON: unexpected ']'`);
          }
          if (this.valueContext) {
            events = appendEvent(events, ...this.emitValueComplete());
          }
          events = appendEvent(events, tokenEndArray);
          this.currentScope = this.stack.pop() ?? {
            type: "global",
            inValue: false,
          };
          break;
        }
        case ":": {
          if (this.currentScope.type !== "object") {
            throw new Error(`Invalid JSON: unexpected ':'`);
          }
          if (this.valueContext?.type !== "string") {
            throw new Error(
              `Invalid JSON: expected a key, but got${
                this.valueContext
                  ? ` unknown literal '${this.valueContext.buffer}'`
                  : ` ':'`
              }`,
            );
          }

          events = appendEvent(events, {
            type: "key",
            value: this.valueContext.buffer,
          });
          this.currentScope = {
            type: "object",
            inValue: true,
          };

          this.valueContext = null;
          break;
        }
        case ",": {
          if (this.currentScope.type === "global") {
            throw new Error(`Invalid JSON: unexpected ','`);
          }
          if (this.valueContext) {
            events = appendEvent(events, ...this.emitValueComplete());
          }
          if (this.currentScope.type === "object") {
            this.currentScope = {
              type: "object",
              inValue: false,
            };
          }
          break;
        }
        case '"': {
          if (!this.valueContext) {
            this.assertCanStartValue('"');
          }
          this.valueContext = {
            type: "string",
            buffer: "",
            parser: new UnicodeStreamParser(),
            isComplete: false,
          };
          break;
        }
        default: {
          const isWhitespace = char === " " || char === "\n" || char === "\t";
          if (isWhitespace) {
            // Whitespace completes a literal value (but not strings)
            if (this.valueContext?.type === "literal") {
              events = appendEvent(events, ...this.emitValueComplete());
            }
          } else {
            if (this.valueContext) {
              this.valueContext.buffer += char;
            } else {
              this.assertCanStartValue(char);
              this.valueContext = { type: "literal", buffer: char };
            }
          }
          break;
        }
      }
    }
    return events;
  }

  end(): JSONParseToken[] {
    if (this.stack.length > 0 || this.currentScope.type !== "global") {
      const unclosed =
        this.currentScope.type === "object"
          ? "}"
          : this.currentScope.type === "array"
            ? "]"
            : "";
      throw new Error(
        `Invalid JSON: unexpected end of input, expected '${unclosed}'`,
      );
    }
    return this.emitValueComplete();
  }

  private maybeEmitValueUpdate(value: string): JSONParseToken | null {
    if (!this.isInStringValue) return null;

    if (this.lastEmittedStringValueUpdate === null) {
      this.lastEmittedStringValueUpdate = value;
      return {
        type: "value_start",
        value,
      };
    }

    if (this.lastEmittedStringValueUpdate === value) return null;

    this.lastEmittedStringValueUpdate = value;

    return {
      type: "value_update",
      value,
    };
  }

  private emitValueComplete(): JSONParseToken[] {
    let events: JSONParseToken[] = [];

    // Closing string in case the JSON is unfinished.
    if (this.valueContext?.type === "string" && !this.valueContext.isComplete) {
      this.valueContext.buffer = this.valueContext.parser.end();
      this.valueContext.isComplete = true;
    }

    if (this.valueContext === null) return events;

    if (this.lastEmittedStringValueUpdate === null) {
      events = appendEvent(events, {
        type: "value_start",
        value: this.parseValue(this.valueContext),
      });
      events = appendEvent(events, {
        type: "value_complete",
        value: this.parseValue(this.valueContext),
      });
    } else {
      events = appendEvent(events, {
        type: "value_complete",
        value: this.parseValue(this.valueContext),
      });
    }

    this.lastEmittedStringValueUpdate = null;
    this.valueContext = null;

    return events;
  }

  private parseValue(
    valueContext: ValueContext,
  ): null | boolean | number | string {
    switch (valueContext.type) {
      case "string": {
        return valueContext.buffer;
      }
      case "literal": {
        if (valueContext.buffer === "true") return true;
        if (valueContext.buffer === "false") return false;
        if (valueContext.buffer === "null") return null;
        if (!Number.isNaN(Number(valueContext.buffer)))
          return Number(valueContext.buffer);
        throw new Error(
          `Invalid JSON: Unexpected literal: ${valueContext.buffer}`,
        );
      }
    }

    throw new Error(
      `Unreachable: unknown value context type: ${(valueContext as { type: string }).type}`,
    );
  }
}

/**
 * This function deduplicates value_update and value_complete events
 * to try to emit as little events as possible.
 */
export const appendEvent = (
  events: JSONParseToken[],
  ...eventsToAppend: JSONParseToken[]
): JSONParseToken[] => {
  const result = [...events];
  for (const event of eventsToAppend) {
    switch (event.type) {
      case "value_update": {
        const lastEvent = result[result.length - 1];
        if (
          lastEvent &&
          (lastEvent.type === "value_start" ||
            lastEvent.type === "value_update")
        ) {
          result[result.length - 1] = { ...lastEvent, value: event.value };
        } else {
          result.push(event);
        }
        break;
      }
      case "value_complete": {
        const lastEvent = result[result.length - 1];
        if (lastEvent && lastEvent.type === "value_update") {
          result[result.length - 1] = event;
        } else {
          result.push(event);
        }
        break;
      }
      case "startObject":
      case "startArray":
      case "endObject":
      case "endArray":
      case "key":
      case "value_start":
      default: {
        result.push(event);
        break;
      }
    }
  }
  return result;
};

type UnicodeEscapeState = { type: "unicode_escape"; digits: string[] };

type UnicodeStreamState =
  | { type: "unescaped" }
  | { type: "escape" }
  | UnicodeEscapeState;

class UnicodeStreamParser {
  private state: UnicodeStreamState = { type: "unescaped" };
  private lowSurrogateState?: { high: number };
  private stringOutput = "";

  get isEscaping(): boolean {
    return this.state.type === "escape";
  }

  constructor(
    private onError: (error: Error) => void = (err) => {
      throw err;
    },
  ) {}

  write(chunk: string): string {
    this.processBuffer(chunk);
    return this.stringOutput;
  }

  end(): string {
    if (this.state.type === "unicode_escape" && this.lowSurrogateState) {
      this.onError(new Error("Unterminated surrogate pair"));
    }
    this.state = { type: "unescaped" };
    return this.stringOutput;
  }

  private processBuffer(chunk: string): void {
    for (const char of chunk) {
      switch (this.state.type) {
        case "unescaped":
          if (char === "\\") {
            this.state = { type: "escape" };
          } else {
            this.stringOutput += char;
          }
          break;

        case "escape":
          if (char === "u") {
            this.state = { type: "unicode_escape", digits: [] };
          } else {
            this.handleEscapeChar(char);
            this.state = { type: "unescaped" };
          }
          break;

        case "unicode_escape":
          this.state.digits.push(char);
          if (this.state.digits.length === 4) {
            this.handleUnicodeEscape(this.state);
            this.state = { type: "unescaped" };
          }
          break;
      }
    }
  }

  private handleEscapeChar(char: string): void {
    const escapeMap: Record<string, string> = {
      '"': '"',
      "\\": "\\",
      "/": "/",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
    };
    this.stringOutput += escapeMap[char] ?? char;
  }

  private handleUnicodeEscape(state: UnicodeEscapeState): void {
    const hexStr = state.digits.join("");
    const codeUnit = parseInt(hexStr, 16);
    if (Number.isNaN(codeUnit)) {
      this.onError(new Error(`Invalid Unicode escape: \\u${hexStr}`));
      return;
    }

    if (this.lowSurrogateState) {
      // Handle low surrogate
      if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
        const high = this.lowSurrogateState.high;
        const codePoint =
          ((high - 0xd800) << 10) + (codeUnit - 0xdc00) + 0x10000;
        this.stringOutput += String.fromCodePoint(codePoint);
      } else {
        this.onError(new Error(`Invalid low surrogate: \\u${hexStr}`));
      }
      this.lowSurrogateState = undefined;
    } else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      // High surrogate, expect low surrogate next
      this.lowSurrogateState = { high: codeUnit };
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      // Lone low surrogate
      this.onError(new Error(`Lone low surrogate: \\u${hexStr}`));
    } else {
      // Regular Unicode character
      this.stringOutput += String.fromCharCode(codeUnit);
      this.lowSurrogateState = undefined;
    }
  }
}
