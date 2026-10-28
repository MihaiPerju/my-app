import { describe, expect, it } from "vitest";

import {
  base64ToUtf8,
  deIndent,
  extractJSONFromCodeBlock,
  splitAsciiString,
  splitTextIntoGraphemes,
  stringify,
  trimTrailingChar,
} from "./strings.js";

describe("splitTextIntoGraphemes", () => {
  it("keeps multi-code-point emoji and combining marks intact", () => {
    expect(splitTextIntoGraphemes("A👨‍👩‍👧‍👦👍🏽e\u0301🇫🇷")).toEqual([
      "A",
      "👨‍👩‍👧‍👦",
      "👍🏽",
      "e\u0301",
      "🇫🇷",
    ]);
  });
});

describe("splitAsciiString", () => {
  it("splits an ASCII string into characters", () => {
    expect(splitAsciiString("#3AF")).toEqual(["#", "3", "A", "F"]);
  });
});

describe("extractJSONFromCodeBlock", () => {
  it("extracts JSON from a standard code block with json language specifier", () => {
    const input = '```json\n{"name": "test", "value": 123}\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"name": "test", "value": 123}');
  });

  it("extracts content from a code block without language specifier", () => {
    const input = '```\n{"name": "test", "value": 123}\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"name": "test", "value": 123}');
  });

  it("handles multi-line JSON with complex structure", () => {
    const input = `\`\`\`json
{
  "users": [
    {"id": 1, "name": "Alice"},
    {"id": 2, "name": "Bob"}
  ],
  "meta": {
    "total": 2,
    "page": 1
  }
}
\`\`\``;
    const result = extractJSONFromCodeBlock(input);
    const expected = `{
  "users": [
    {"id": 1, "name": "Alice"},
    {"id": 2, "name": "Bob"}
  ],
  "meta": {
    "total": 2,
    "page": 1
  }
}`;
    expect(result).toBe(expected);
  });

  it("trims whitespace inside code blocks", () => {
    const input = '```json\n\n  {"key": "value"}  \n\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"key": "value"}');
  });

  it("trims whitespace outside code blocks", () => {
    const input = '\n\n  ```json\n{"key": "value"}\n```  \n\n';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"key": "value"}');
  });

  it("returns trimmed original string when no code block is present", () => {
    const input = '  {"name": "test", "value": 123}  ';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"name": "test", "value": 123}');
  });

  it("handles code blocks with special characters and escape sequences", () => {
    const input =
      '```json\n{"message": "Hello\\nWorld", "emoji": "🚀", "path": "/api/test"}\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe(
      '{"message": "Hello\\nWorld", "emoji": "🚀", "path": "/api/test"}',
    );
  });

  it("ignores malformed code blocks (missing closing backticks)", () => {
    const input = '```json\n{"incomplete": true}';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('```json\n{"incomplete": true}');
  });

  it("ignores malformed code blocks (missing opening backticks)", () => {
    const input = '{"incomplete": true}\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"incomplete": true}\n```');
  });

  it("handles code blocks with extra backticks inside content", () => {
    const input =
      '```json\n{"code": "`console.log(\\"test\\");`", "value": true}\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe(
      '{"code": "`console.log(\\"test\\");`", "value": true}',
    );
  });

  it("handles very large JSON objects", () => {
    const largeObject = {
      data: Array.from({ length: 100 }, (_, i) => ({
        id: i,
        name: `Item ${i}`,
      })),
      metadata: { count: 100, generated: new Date().toISOString() },
    };
    const jsonString = stringify(largeObject);
    const input = `\`\`\`json\n${jsonString}\n\`\`\``;
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe(jsonString);
  });

  it("handles empty string input", () => {
    const input = "";
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe("");
  });

  it("handles whitespace-only input", () => {
    const input = "   \n  \t  \n   ";
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe("");
  });

  it("preserves internal formatting of JSON while trimming edges", () => {
    const input = `\`\`\`json

{
  "formatted": {
    "with":    "extra spaces",
    "and": [
      1,    2,    3
    ]
  }
}

\`\`\``;
    const expected = `{
  "formatted": {
    "with":    "extra spaces",
    "and": [
      1,    2,    3
    ]
  }
}`;
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe(expected);
  });

  it("handles code blocks with text before and after", () => {
    const input =
      'Some text before ```json\n{"name": "test", "value": 123}\n``` some text after';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"name": "test", "value": 123}');
  });

  it("returns the last code block when multiple are present", () => {
    const input =
      '```json\n{"first": true}\n``` some text ```json\n{"second": true}\n```';
    const result = extractJSONFromCodeBlock(input);
    expect(result).toBe('{"second": true}');
  });
});

describe("deIndent", () => {
  it("returns the same string if there is no indentation", () => {
    const input = `function hello() {\n  return "world";\n}`;
    const expected = `function hello() {\n  return "world";\n}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("removes uniform indentation", () => {
    const input = `
    function hello() {
      return "world";
    }`;
    const expected = `function hello() {
  return "world";
}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("removes shared indentation but keep differing indentation", () => {
    const input = `  function hello() {\n    return "world";\n  }`;
    const expected = `function hello() {\n  return "world";\n}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("handles empty lines correctly", () => {
    const input = `  function hello() {\n\n    return "world";\n\n  }`;
    const expected = `function hello() {\n\n  return "world";\n\n}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("handles mixed whitespace characters", () => {
    const input = `\t\tfunction hello() {\n\t\t  return "world";\n\t\t}`;
    const expected = `function hello() {\n  return "world";\n}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("handles strings with only spaces", () => {
    const input = `   \n   \n   `;
    expect(deIndent(input)).toBe(input);
  });

  it("handles strings with only tabs", () => {
    const input = `\t\t\t\n\t\t\t\n\t\t\t`;
    expect(deIndent(input)).toBe(input);
  });

  it("handles mixed spaces and tabs", () => {
    const input = `  \tfunction hello() {\n  \t  return "world";\n  \t}`;
    const expected = `function hello() {\n  return "world";\n}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("handles irregular indentation", () => {
    const input = `
    function hello() {
      return "world";
        \tconsole.log("hello");
    }`;
    const expected = `function hello() {
  return "world";
    \tconsole.log("hello");
}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("works with interpolated strings", () => {
    const input = deIndent`
    function hello() {
      return ${'"world"'};
    }`;
    const expected = `function hello() {
  return "world";
}`;
    expect(deIndent(input)).toBe(expected);
  });

  it("ignores first line when calculating shared indentation if it has no leading whitespace", () => {
    const input = deIndent`todo
                 list:
                     - task1
                     - task2`;
    const expected = `todo
list:
    - task1
    - task2`;
    expect(input).toBe(expected);
  });

  it("still de-indents first line if it has leading whitespace", () => {
    const input = `  first line
    second line
    third line`;
    const expected = `first line
  second line
  third line`;
    expect(deIndent(input)).toBe(expected);
  });
});

describe("stringify", () => {
  it("preserves strings as-is", () => {
    expect(stringify('{"already":"json"}')).toBe('{"already":"json"}');
  });

  it("JSON-encodes serializable non-string values", () => {
    expect(stringify({ ok: true })).toBe('{"ok":true}');
  });

  it("falls back to String for values JSON cannot serialize", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(stringify(undefined)).toBe("undefined");
    expect(stringify(circular)).toBe("[object Object]");
  });

  it("pretty-prints objects when space is provided", () => {
    expect(stringify({ a: 1 }, null, 2)).toBe('{\n  "a": 1\n}');
  });

  it("uses a custom space string when provided", () => {
    expect(stringify({ a: 1 }, null, "\t")).toBe('{\n\t"a": 1\n}');
  });

  it("filters keys when replacer array is provided", () => {
    expect(stringify({ a: 1, b: 2 }, ["a"])).toBe('{"a":1}');
  });

  it("ignores replacer and space when value is already a string", () => {
    expect(stringify('{"already":"json","skip":true}', ["skip"], 2)).toBe(
      '{"already":"json","skip":true}',
    );
  });
});

describe("trimTrailingChar", () => {
  it("removes every trailing occurrence of the given character", () => {
    expect(trimTrailingChar("https://console.mistral.ai///", "/")).toBe(
      "https://console.mistral.ai",
    );
  });

  it("preserves matching characters that are not trailing", () => {
    expect(trimTrailingChar("https://console.mistral.ai/path", "/")).toBe(
      "https://console.mistral.ai/path",
    );
  });

  it("requires exactly one trailing character", () => {
    expect(() => trimTrailingChar("value", "")).toThrow(
      "trimTrailingChar expects exactly one character.",
    );
    expect(() => trimTrailingChar("value", "//")).toThrow(
      "trimTrailingChar expects exactly one character.",
    );
  });
});

describe("base64ToUtf8", () => {
  it("decodes a base64 string to a UTF-8 string", () => {
    const input = "SGVsbG8gV29ybGQ=";
    const expected = "Hello World";
    expect(base64ToUtf8(input)).toBe(expected);
  });
  it("decodes a base64 string to a UTF-8 string with emojis and complex characters", () => {
    const input =
      "SGVsbG8gV29ybGTwn5qA8J+agPCfmoAuIEkgaGF2ZSBhY2NlbnRzIGFuZCBvdGhlciBzcGVjaWFsIGNoYXJhY3RlcnMgbGlrZSDDqcOgw7nDp8Oiw6rDrsO0w7vDq8Ovw7wu";
    const expected =
      "Hello World🚀🚀🚀. I have accents and other special characters like éàùçâêîôûëïü.";
    expect(base64ToUtf8(input)).toBe(expected);
  });
});
