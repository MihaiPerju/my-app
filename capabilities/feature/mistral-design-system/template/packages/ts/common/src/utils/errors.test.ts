import { describe, expect, it } from "vitest";

import { getErrorMessage, toError } from "./errors";

describe("getErrorMessage", () => {
  describe("Error instances", () => {
    it("extracts message from an Error instance", () => {
      const error = new Error("Something went wrong");
      expect(getErrorMessage(error)).toBe("Something went wrong");
    });

    it("extracts message from a TypeError", () => {
      const error = new TypeError("Type error occurred");
      expect(getErrorMessage(error)).toBe("Type error occurred");
    });

    it("extracts message from a custom Error subclass", () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomError";
        }
      }
      const error = new CustomError("Custom error message");
      expect(getErrorMessage(error)).toBe("Custom error message");
    });

    it("handles Error with empty message", () => {
      const error = new Error("");
      expect(getErrorMessage(error)).toBe("");
    });
  });

  describe("Error-like objects", () => {
    it("extracts message from object with message property", () => {
      const error = { message: "Custom error object" };
      expect(getErrorMessage(error)).toBe("Custom error object");
    });

    it("extracts message from object with message and other properties", () => {
      const error = { message: "API error", code: 500, status: "error" };
      expect(getErrorMessage(error)).toBe("API error");
    });

    it("ignores non-string message properties", () => {
      const error = { message: 12345 };
      const result = getErrorMessage(error);
      expect(result).toBe(JSON.stringify(error));
    });

    it("ignores null message property", () => {
      const error = { message: null };
      const result = getErrorMessage(error);
      expect(result).toBe(JSON.stringify(error));
    });
  });

  describe("String errors", () => {
    it("returns string error as-is", () => {
      const error = "Simple string error";
      expect(getErrorMessage(error)).toBe("Simple string error");
    });

    it("handles empty string", () => {
      const error = "";
      expect(getErrorMessage(error)).toBe("");
    });
  });

  describe("JSON stringifiable values", () => {
    it("stringifies number", () => {
      const error = 42;
      expect(getErrorMessage(error)).toBe("42");
    });

    it("stringifies boolean", () => {
      expect(getErrorMessage(true)).toBe("true");
      expect(getErrorMessage(false)).toBe("false");
    });

    it("stringifies object", () => {
      const error = { code: 500, details: "Server error" };
      expect(getErrorMessage(error)).toBe(
        JSON.stringify({ code: 500, details: "Server error" }),
      );
    });

    it("stringifies array", () => {
      const error = [1, 2, 3];
      expect(getErrorMessage(error)).toBe("[1,2,3]");
    });

    it("stringifies null", () => {
      const error = null;
      expect(getErrorMessage(error)).toBe("null");
    });
  });

  describe("Non-JSON stringifiable values", () => {
    it("handles undefined", () => {
      const error = undefined;
      expect(getErrorMessage(error)).toBe("undefined");
    });

    it("handles circular references", () => {
      const error: Record<string, unknown> = { name: "circular" };
      error.self = error; // Create circular reference

      const result = getErrorMessage(error);
      // Fallbacks to String() conversion
      expect(result).toBe("[object Object]");
    });

    it("handles objects with toJSON that throws", () => {
      const error = {
        toJSON() {
          throw new Error("toJSON failed");
        },
      };

      const result = getErrorMessage(error);
      expect(result).toBe("[object Object]");
    });

    it("handles Symbol", () => {
      const error = Symbol("test");
      expect(getErrorMessage(error)).toBe("Symbol(test)");
    });

    it("handles BigInt", () => {
      const error = BigInt(9007199254740991);
      expect(getErrorMessage(error)).toBe("9007199254740991");
    });
  });

  describe("Edge cases", () => {
    it("handles function", () => {
      const error = function testFunc() {};
      const result = getErrorMessage(error);
      expect(typeof result).toBe("string");
      expect(result).toContain("testFunc");
    });

    it("handles arrow function", () => {
      const error = () => {};
      const result = getErrorMessage(error);
      expect(typeof result).toBe("string");
    });

    it("handles Date object", () => {
      const error = new Date("2024-01-01");
      const result = getErrorMessage(error);
      expect(result).toContain("2024");
    });

    it("handles RegExp", () => {
      const error = /test/gi;
      expect(getErrorMessage(error)).toBe("/test/gi");
    });

    it("handles object with toString method", () => {
      const error = {
        toString() {
          return "Custom toString result";
        },
      };
      // Will try JSON.stringify first, then String()
      const result = getErrorMessage(error);
      expect(typeof result).toBe("string");
    });

    it("handles object with both message and toString", () => {
      const error = {
        message: "Has message property",
        toString() {
          return "Has toString method";
        },
      };
      // Prefers message property
      expect(getErrorMessage(error)).toBe("Has message property");
    });

    it("returns fallback for truly unparseable errors", () => {
      // Create an object that throws on both JSON.stringify and String()
      const error = {
        toJSON() {
          throw new Error("Cannot JSON");
        },
        toString() {
          throw new Error("Cannot String");
        },
        valueOf() {
          throw new Error("Cannot valueOf");
        },
      };

      const result = getErrorMessage(error);
      expect(result).toBe("Unknown error");
    });
  });
});

describe("toError", () => {
  describe("Error instances", () => {
    it("returns Error instance as-is", () => {
      const error = new Error("Something went wrong");
      const result = toError(error);
      expect(result).toBe(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Something went wrong");
    });

    it("returns TypeError instance as-is", () => {
      const error = new TypeError("Type error occurred");
      const result = toError(error);
      expect(result).toBe(error);
      expect(result).toBeInstanceOf(TypeError);
      expect(result).toBeInstanceOf(Error);
    });

    it("returns custom Error subclass as-is", () => {
      class CustomError extends Error {
        constructor(message: string) {
          super(message);
          this.name = "CustomError";
        }
      }
      const error = new CustomError("Custom error message");
      const result = toError(error);
      expect(result).toBe(error);
      expect(result).toBeInstanceOf(CustomError);
      expect(result).toBeInstanceOf(Error);
    });

    it("preserves error stack trace", () => {
      const error = new Error("Test error");
      const result = toError(error);
      expect(result.stack).toBe(error.stack);
    });
  });

  describe("String errors", () => {
    it("converts string to Error", () => {
      const error = "Simple string error";
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Simple string error");
    });

    it("converts empty string to Error", () => {
      const error = "";
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("");
    });
  });

  describe("Error-like objects", () => {
    it("converts object with message property to Error", () => {
      const error = { message: "Custom error object" };
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Custom error object");
    });

    it("converts object with message and other properties to Error", () => {
      const error = { message: "API error", code: 500, status: "error" };
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("API error");
    });
  });

  describe("Primitive values", () => {
    it("converts number to Error", () => {
      const error = 42;
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("42");
    });

    it("converts boolean to Error", () => {
      const error = true;
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("true");
    });

    it("converts null to Error", () => {
      const error = null;
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("null");
    });

    it("converts undefined to Error", () => {
      const error = undefined;
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("undefined");
    });
  });

  describe("Complex objects", () => {
    it("converts object to Error with JSON stringified message", () => {
      const error = { code: 500, details: "Server error" };
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe(
        JSON.stringify({ code: 500, details: "Server error" }),
      );
    });

    it("converts array to Error", () => {
      const error = [1, 2, 3];
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("[1,2,3]");
    });

    it("handles circular references", () => {
      const error: Record<string, unknown> = { name: "circular" };
      error.self = error;
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("[object Object]");
    });
  });

  describe("Edge cases", () => {
    it("handles Symbol", () => {
      const error = Symbol("test");
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Symbol(test)");
    });

    it("handles function", () => {
      const error = function testFunc() {};
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(typeof result.message).toBe("string");
      expect(result.message).toContain("testFunc");
    });

    it("returns Error with 'Unknown error' for truly unparseable values", () => {
      const error = {
        toJSON() {
          throw new Error("Cannot JSON");
        },
        toString() {
          throw new Error("Cannot String");
        },
        valueOf() {
          throw new Error("Cannot valueOf");
        },
      };
      const result = toError(error);
      expect(result).toBeInstanceOf(Error);
      expect(result.message).toBe("Unknown error");
    });
  });
});
