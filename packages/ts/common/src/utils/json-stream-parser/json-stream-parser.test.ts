import { describe, expect, it } from "vitest";

import { apply, diff, type Patch } from "../patch";
import { appendEvent, JSONStreamParser, setLast } from "./json-stream-parser";
import type { ServerStreamChunk } from "./test-helpers";
import { complexJsonExamples, createLlmJsonStream } from "./test-helpers";

describe("JSONStreamParser", () => {
  it("should parse a simple string value", () => {
    const parser = new JSONStreamParser();
    parser.write('"hello"');
    const result = parser.end();
    expect(result).toBe("hello");
  });

  it("should parse a simple number value", () => {
    const parser = new JSONStreamParser();
    parser.write("42");
    const result = parser.end();
    expect(result).toBe(42);
  });

  it("should parse a simple boolean value", () => {
    const parser = new JSONStreamParser();
    parser.write("true");
    const result = parser.end();
    expect(result).toBe(true);
  });

  it("should parse a simple null value", () => {
    const parser = new JSONStreamParser();
    parser.write("null");
    const result = parser.end();
    expect(result).toBe(null);
  });

  it("should parse a simple object", () => {
    const parser = new JSONStreamParser();
    parser.write('{"name":"Alice","age":30}');
    const result = parser.end();
    expect(result).toEqual({ name: "Alice", age: 30 });
  });

  it("should parse a simple array", () => {
    const parser = new JSONStreamParser();
    parser.write("[1,2,3]");
    const result = parser.end();
    expect(result).toEqual([1, 2, 3]);
  });

  it("should handle incremental parsing", () => {
    const parser = new JSONStreamParser();
    parser.write('{"name":"');
    parser.write("Alice");
    parser.write('"}');
    const result = parser.end();
    expect(result).toEqual({ name: "Alice" });
  });

  it("should handle nested structures", () => {
    const parser = new JSONStreamParser();
    parser.write('{"person":{"name":"Alice","age":30}}');
    const result = parser.end();
    expect(result).toEqual({ person: { name: "Alice", age: 30 } });
  });

  it("should handle array of objects", () => {
    const parser = new JSONStreamParser();
    parser.write('[{"name":"Alice"},{"name":"Bob"}]');
    const result = parser.end();
    expect(result).toEqual([{ name: "Alice" }, { name: "Bob" }]);
  });

  it("should handle complex nested structures", () => {
    const parser = new JSONStreamParser();
    const complexJson =
      '{"users":[{"name":"Alice","friends":["Bob","Charlie"]},{"name":"Dave"}]}';
    parser.write(complexJson);
    const result = parser.end();
    expect(result).toEqual({
      users: [{ name: "Alice", friends: ["Bob", "Charlie"] }, { name: "Dave" }],
    });
  });

  it("should handle string updates", () => {
    const parser = new JSONStreamParser();
    parser.write('{"name":"A');
    const result1 = parser.getCurrentValue();
    expect(result1).toEqual({ name: "A" });
    parser.write('lice"}');
    const result2 = parser.getCurrentValue();
    expect(result2).toEqual({ name: "Alice" });
  });

  it("should handle multiple values in array", () => {
    const parser = new JSONStreamParser();
    parser.write("[");
    parser.write("1");
    parser.write(",");
    parser.write("2");
    parser.write("]");
    const result = parser.getCurrentValue();
    expect(result).toEqual([1, 2]);
  });

  it("should handle escaped characters in strings", () => {
    const parser = new JSONStreamParser();
    parser.write('{"text":"Hello\\nWorld"}');
    const result = parser.getCurrentValue();
    const parsedResult = JSON.parse('{"text":"Hello\\nWorld"}');
    expect(parsedResult).toEqual({ text: "Hello\nWorld" });
    expect(result).toEqual({ text: "Hello\nWorld" });
  });

  it("should handle empty object", () => {
    const parser = new JSONStreamParser();
    parser.write("{}");
    const result = parser.getCurrentValue();
    expect(result).toEqual({});
  });

  it("should handle empty array", () => {
    const parser = new JSONStreamParser();
    parser.write("[]");
    const result = parser.getCurrentValue();
    expect(result).toEqual([]);
  });

  it("should handle unicode characters in strings", () => {
    const parser = new JSONStreamParser();
    parser.write('{"text":"🚀"}');
    const result = parser.getCurrentValue();
    expect(result).toEqual({ text: "🚀" });
  });

  it("should support all harmony code points", () => {
    const parser = new JSONStreamParser();

    // Special token	Purpose	Token ID
    const specialTokens = [
      // <|start|>	Indicates the beginning of a message. Followed by the “header” information of a message starting with the role	200006
      String.fromCodePoint(200006),
      // <|end|>	Indicates the end of a message	200007
      String.fromCodePoint(200007),
      // <|message|>	Indicates the transition from the message “header” to the actual content	200008
      String.fromCodePoint(200008),
      // <|channel|>	Indicates the transition to the channel information of the header	200005
      String.fromCodePoint(200005),
      // <|constrain|>	Indicates the transition to the data type definition in a tool call	200003
      String.fromCodePoint(200003),
      // <|return|>	Indicates the model is done with sampling the response message. A valid “stop token” indicating that you should stop inference.	200002
      String.fromCodePoint(200002),
      // <|call|>	Indicates the model wants to call a tool. A valid “stop token” indicating that you should stop inference.	200012
      String.fromCodePoint(200012),
    ];
    const tokens = ['{ "text": "', ...specialTokens, '" }'];

    parser.write(tokens.join(""));
    const result = parser.getCurrentValue();
    expect(result).toEqual({ text: specialTokens.join("") });
  });

  it.each([
    {
      expected: "🐵",
      input: "\\uD83D\\uDC35",
    },
    {
      expected: "😊🐵",
      input: "\\uD83D\\uDE0A\\uD83D\\uDC35",
    },
    {
      expected: "😊🐵🐶",
      input: "\\uD83D\\uDE0A\\uD83D\\uDC35\\uD83D\\uDC36",
    },
    {
      expected: "👨‍👩‍👧‍👦",
      input:
        "\\uD83D\\uDC68\\u200D\\uD83D\\uDC69\\u200D\\uD83D\\uDC67\\u200D\\uD83D\\uDC66",
    },
  ])(
    "should handle surrogate pairs in strings – $expected",
    ({ input, expected }) => {
      const parser = new JSONStreamParser();
      parser.write(`{"text":"${input}"}`);
      const result = parser.getCurrentValue();
      expect(result).toEqual({ text: expected });
    },
  );

  it("should handle control characters in strings", () => {
    const parser = new JSONStreamParser();
    parser.write('{"text":"\\u0000"}');
    const result = parser.getCurrentValue();
    expect(result).toEqual({ text: "\u0000" });
  });

  it("should handle unicode escapes in strings", () => {
    const parser = new JSONStreamParser();
    parser.write('{"text":"\\u00A0"}');
    const result = parser.getCurrentValue();
    expect(result).toEqual({ text: "\u00A0" });
  });

  it("should support empty strings as keys and values", () => {
    const parser = new JSONStreamParser();
    parser.write('{"":""}');
    const result = parser.getCurrentValue();
    expect(result).toEqual({ "": "" });
  });

  describe("error handling", () => {
    it("should throw on unexpected '}'", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("}")).toThrow("Invalid JSON: unexpected '}'");
    });

    it("should throw on unexpected ']'", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("]")).toThrow("Invalid JSON: unexpected ']'");
    });

    it("should throw on mismatched brackets: {]", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("{]")).toThrow("Invalid JSON: unexpected ']'");
    });

    it("should throw on mismatched brackets: [}", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("[}")).toThrow("Invalid JSON: unexpected '}'");
    });

    it("should throw on unexpected ':' outside object", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write(":")).toThrow("Invalid JSON: unexpected ':'");
    });

    it("should throw on unexpected ':' in array", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("[:]")).toThrow("Invalid JSON: unexpected ':'");
    });

    it("should throw on unexpected ',' at global scope", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write(",")).toThrow("Invalid JSON: unexpected ','");
    });

    it("should throw on multiple values at global scope", () => {
      const parser = new JSONStreamParser();
      parser.write("true");
      expect(() => parser.write(" false")).toThrow(
        "Invalid JSON: unexpected 'f' after value",
      );
    });

    it("should throw on multiple values at global scope (number then string)", () => {
      const parser = new JSONStreamParser();
      parser.write("123");
      expect(() => parser.write(' "abc"')).toThrow(
        "Invalid JSON: unexpected '\"' after value",
      );
    });

    it("should throw on multiple values at global scope (object then object)", () => {
      const parser = new JSONStreamParser();
      parser.write("{}");
      expect(() => parser.write("{}")).toThrow(
        "Invalid JSON: unexpected '{' after value",
      );
    });

    it("should throw on unclosed object at end()", () => {
      const parser = new JSONStreamParser();
      parser.write("{");
      expect(() => parser.end()).toThrow(
        "Invalid JSON: unexpected end of input, expected '}'",
      );
    });

    it("should throw on unclosed array at end()", () => {
      const parser = new JSONStreamParser();
      parser.write("[");
      expect(() => parser.end()).toThrow(
        "Invalid JSON: unexpected end of input, expected ']'",
      );
    });

    it("should throw on unclosed nested structure at end()", () => {
      const parser = new JSONStreamParser();
      parser.write('{"a": [1, 2');
      expect(() => parser.end()).toThrow(
        "Invalid JSON: unexpected end of input, expected ']'",
      );
    });

    it("should throw on invalid literal", () => {
      const parser = new JSONStreamParser();
      parser.write("undefined");
      expect(() => parser.end()).toThrow(
        "Invalid JSON: Unexpected literal: undefined",
      );
    });

    it("should throw on non-string key in object", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("{123: 456}")).toThrow(
        "Invalid JSON: expected a key, got '1'",
      );
    });

    it("should throw when object key is not followed by string", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write("{true: 1}")).toThrow(
        "Invalid JSON: expected a key, got 't'",
      );
    });

    it("should throw on colon without preceding key", () => {
      const parser = new JSONStreamParser();
      expect(() => parser.write('{"a": 1, : 2}')).toThrow(
        "Invalid JSON: expected a key, but got ':'",
      );
    });
  });

  describe("complex cases", () => {
    /**
     * Turn stream of incomplete JSON into JSON patches.
     */
    const serverStream = function* (
      jsonChunkStream: Generator<string>,
    ): Generator<ServerStreamChunk> {
      const parser = new JSONStreamParser();

      let previousServerResult: unknown = null;
      for (const chunk of jsonChunkStream) {
        parser.write(chunk);
        const serverResult = parser.getCurrentValue();

        if (serverResult === null) {
          continue;
        }

        if (previousServerResult === null) {
          yield { type: "initialization", value: serverResult };
          previousServerResult = serverResult;
          continue;
        }

        const patch: Patch[] = diff(previousServerResult, serverResult);

        previousServerResult = serverResult;
        if (patch.length) {
          yield { type: "update", patch };
        }
      }
      const finalResult = parser.end();
      yield { type: "complete", value: finalResult };
    };

    it.each(complexJsonExamples)(
      "end-to-end parsing – $description",
      ({ input }) => {
        const llmJsonStream = createLlmJsonStream(input);

        let wipValue: unknown = null;
        for (const chunk of serverStream(llmJsonStream)) {
          switch (chunk.type) {
            case "initialization": {
              wipValue = chunk.value;
              break;
            }
            case "update": {
              wipValue = apply(wipValue, chunk.patch);
              break;
            }
            case "complete": {
              wipValue = chunk.value;
              break;
            }
          }
        }
        expect(wipValue).toEqual(JSON.parse(input));
      },
    );
  });
});

describe("appendEvent", () => {
  it("does not mutate the original events array", () => {
    const original = [{ type: "startObject" as const }];
    const snapshot = [...original];

    appendEvent(original, { type: "endObject" as const });

    expect(original).toEqual(snapshot);
  });

  it("returns a new array containing the appended event", () => {
    const original = [{ type: "startObject" as const }];
    const result = appendEvent(original, { type: "endObject" as const });

    expect(result).toEqual([{ type: "startObject" }, { type: "endObject" }]);
  });

  it("coalesces consecutive value_update events into the last value_start", () => {
    const original = [{ type: "value_start" as const, value: "he" as const }];
    const result = appendEvent(original, {
      type: "value_update" as const,
      value: "hel" as const,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ type: "value_start", value: "hel" });
    expect(original[0]).toEqual({ type: "value_start", value: "he" });
  });
});

describe("setLast", () => {
  it("updates the last element of the array", () => {
    const arr = [1, 2, 3];
    setLast(arr, 99);
    expect(arr).toEqual([1, 2, 99]);
  });

  it("throws when called on an empty array", () => {
    expect(() => setLast([], "value")).toThrow("setLast called on empty array");
  });
});
