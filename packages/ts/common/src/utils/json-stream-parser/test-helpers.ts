import type { Patch } from "../patch";

export type ServerStreamChunk =
  | { type: "initialization"; value: unknown }
  | { type: "update"; patch: Patch[] }
  | { type: "complete"; value: unknown };

export const createLlmJsonStream = function* (
  jsonString: string,
): Generator<string> {
  yield* splitStringRandomly(jsonString);
};

const splitStringRandomly = (str: string) => {
  const result: string[] = [];
  while (str.length > 0) {
    const randomIndex = numberBetween(1, Math.min(4, str.length));
    result.push(str.slice(0, randomIndex));
    str = str.slice(randomIndex);
  }
  return result;
};

const numberBetween = (min: number, max: number) => {
  return Math.floor(Math.random() * (max - min + 1)) + min;
};

export const complexJsonExamples = [
  {
    description: "simple string",
    input: `"Hello\\u00A0World"`,
  },
  {
    description: "simple number",
    input: `123`,
  },
  {
    description: "simple boolean",
    input: `true`,
  },
  {
    description: "simple null",
    input: `null`,
  },
  {
    description: "complex object",
    input: `[
      {
        "name": "Alice",
        "age": 30,
        "phone": "1234",
        "friends": ["Bob", "Charlie"],
        "address": [{ "city": "Paris", "street": "123 Main street" }],
        "hobbies": null,
        "nested": {
          "random": [null, 1, 2, "string", [1, [2, [3, [4, [5]]]]]],
          "escaped": {
            "\\"key in quotes\\"": "\\"value in quotes\\"",
            "orphan \\" quote": "orphan \\" quote"
          },
          "prop": {
              "array": [
                1,
                2,
                { "prop": { "array": [3, 4, 5] } }
              ]
          }
        }
      }
    ]`,
  },
  {
    description: "simple array",
    input: `[1, 2, 3]`,
  },
  {
    description: "simple object",
    input: `{"name":"Alice","age":30}`,
  },
  {
    description: "string with emojis",
    input: JSON.stringify("🚀🥇😊👈"),
  },
  {
    description: "long string with unicode composition",
    input: `{"name":"super long string that never ends \\uD83D\\uDC68\\u200D\\uD83D\\uDC69\\u200D\\uD83D\\uDC67\\u200D\\uD83D\\uDC66 with unicode composition in the middle.","age":30}`,
  },
  {
    description: "all edge cases",
    input: `{
        "🧪 _test": "🚀 Stress-test JSON parser 🚀",
        "nested": {
          "level1": {
            "level2": {
              "level3": {
                "level4": {
                  "level5": {
                    "level6": {
                      "level7": {
                        "level8": {
                          "level9": {
                            "level10": {
                              "deep": true,
                              "array": [
                                [
                                  [
                                    [
                                      [1, 2, 3, {"a": "b"}]
                                    ]
                                  ]
                                ]
                              ],
                              "empty": {},
                              "nullValue": null,
                              "unicodeKey🌍": "unicodeValue🌍",
                              "escapes": "\\\\\\"\\\\\\\\\\\\/\\\\b\\\\f\\\\n\\\\r\\\\t\\u00A9\\uD83D\\uDE00\\uD83D\\uDC35",
                              "surrogatePair": "\\uD83D\\uDE0A",
                              "mixed": [
                                42,
                                -42,
                                3.14159265359,
                                -3.14159265359e+10,
                                1.7976931348623157e+308,
                                -1.7976931348623157e+308,
                                2.2250738585072014e-308,
                                true,
                                false,
                                null,
                                "",
                                " ",
                                "\\u0000",
                                "\\uFFFF",
                                "\\uD83D\\uDE00",
                                "\\uD83D\\uDC35",
                                {"": ""},
                                {"\\uD83D\\uDE00": "\\uD83D\\uDC35"},
                                [],
                                [null],
                                [1, "2", true, false, null, {}],
                                {"\\uD83D\\uDE00": ["\\uD83D\\uDC35", {"nested": {}}]}
                              ],
                              "objectWithAllTypes": {
                                "string": "Hello\\\\nWorld\\\\u00A9",
                                "number": 1234567890.123456789,
                                "boolean": true,
                                "null": null,
                                "array": [1, "2", true, false, null, {}],
                                "emptyObject": {},
                                "emptyArray": [],
                                "scientificNotation": 1.23e-45,
                                "negativeZero": -0,
                                "infinityPlaceholder": "Infinity",
                                "naNPlaceholder": "NaN"
                              },
                              "trailingCommaObject": {
                                "valid": true
                              },
                              "trailingCommaArray": [1, 2, 3]
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        },
        "specialNumbers": {
          "maxInt": 9007199254740991,
          "minInt": -9007199254740991,
          "maxSafeInteger": 9007199254740991,
          "minSafeInteger": -9007199254740991,
          "maxFloat": 1.7976931348623157e+308,
          "minFloat": -1.7976931348623157e+308,
          "epsilon": 2.2250738585072014e-308
        },
        "edgeCases": {
          "emptyString": "",
          "whitespaceString": "   \\t\\n\\r",
          "controlChars": "\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000B\\f\\r\\u000E\\u000F\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001A\\u001B\\u001C\\u001D\\u001E\\u001F",
          "invalidUnicodeEscape": "\\\\uXYZ",
          "unclosed": {
            "object": "{",
            "array": "[",
            "string": "\\"unclosed"
          },
          "circularReferencePlaceholder": "[Circular]",
          "commentsPlaceholder": "// This is not valid JSON, but some parsers might choke on it"
        },
        "largeArray": [
          1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20,
          21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40,
          41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 60,
          61, 62, 63, 64, 65, 66, 67, 68, 69, 70, 71, 72, 73, 74, 75, 76, 77, 78, 79, 80,
          81, 82, 83, 84, 85, 86, 87, 88, 89, 90, 91, 92, 93, 94, 95, 96, 97, 98, 99, 100
        ],
        "mixedWhitespace": {
          "tabKey\\t": "tabValue\\t",
          "newlineKey\\n": "newlineValue\\n",
          "carriageReturnKey\\r": "carriageReturnValue\\r"
        },
        "unicodeKeys": {
          "😊": "smile",
          "❤️": "heart",
          "🎉": "party",
          "🐶": "dog",
          "🍣": "sushi",
          "🚀": "rocket"
        },
        "nestedArrays": [
          [],
          [[]],
          [[[]]],
          [[[[]]]],
          [[[[[]]]]],
          [[[[[{}]]]]],
          [[[[[{"a": "b"}]]]]]
        ],
        "finalTest": {
          "validJSON": true,
          "butDidItCrash?": false
        }
      }
    `,
  },
];
