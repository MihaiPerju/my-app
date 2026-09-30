import { describe, expect, it } from "vitest";
import { z } from "zod";

import { some } from "./option";
import { safeJSONParse, safeParse } from "./safe-parse";

describe("safeParse", () => {
  it("parses valid JSON object and return Some", () => {
    const validJson = '{"name": "John", "age": 30}';
    const result = safeParse(validJson);

    expect(result).toEqual(some({ name: "John", age: 30 }));
  });

  it("parses valid JSON array and return Some", () => {
    const validJson = "[1, 2, 3]";
    const result = safeParse(validJson);

    expect(result).toEqual(some([1, 2, 3]));
  });

  it.each([
    ['"hello world"', "hello world"],
    ["42", 42],
    ["true", true],
    ["null", null],
  ])("parses valid JSON %s and returns Some", (json, expected) => {
    const result = safeParse(json);
    expect(result).toEqual(some(expected));
  });

  it.each([
    ['{"name": "John", "age":}'],
    ['{name: "John"}'],
    ['{"name": "John"'],
    [""],
    ["hello world"],
  ])("returns null for %s", (invalidJson) => {
    const result = safeParse(invalidJson);
    expect(result).toBe(null);
  });
});

describe("safeJSONParse", () => {
  const UserSchema = z.object({
    name: z.string(),
    age: z.number(),
  });

  const PersonSchema = z.object({
    name: z.string(),
    age: z.number(),
    email: z.string().email().optional(),
  });

  const NumberArraySchema = z.array(z.number());

  it("parses and validates valid JSON that matches schema", () => {
    const validJson = '{"name": "John", "age": 30}';
    const result = safeJSONParse(validJson, UserSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "John", age: 30 });
    }
  });

  it("parses and validates complex schema with optional fields", () => {
    const validJson =
      '{"name": "Jane", "age": 25, "email": "jane@example.com"}';
    const result = safeJSONParse(validJson, PersonSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "Jane",
        age: 25,
        email: "jane@example.com",
      });
    }
  });

  it("handles optional fields correctly", () => {
    const validJson = '{"name": "Bob", "age": 35}';
    const result = safeJSONParse(validJson, PersonSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({ name: "Bob", age: 35 });
    }
  });

  it("parses and validates arrays", () => {
    const validJson = "[1, 2, 3, 4, 5]";
    const result = safeJSONParse(validJson, NumberArraySchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual([1, 2, 3, 4, 5]);
    }
  });

  it("returns error when JSON is valid but does not match schema", () => {
    const validJsonInvalidSchema = '{"name": "John", "age": "thirty"}'; // age should be number
    const result = safeJSONParse(validJsonInvalidSchema, UserSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("returns error when required fields are missing", () => {
    const missingFieldJson = '{"name": "John"}'; // missing age
    const result = safeJSONParse(missingFieldJson, UserSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("returns error when schema validation fails for arrays", () => {
    const invalidArrayJson = '[1, "two", 3]'; // mixed types, should be all numbers
    const result = safeJSONParse(invalidArrayJson, NumberArraySchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("handles nested objects", () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string(),
        details: z.object({
          age: z.number(),
          city: z.string(),
        }),
      }),
    });

    const validNestedJson = JSON.stringify({
      user: {
        name: "Alice",
        details: {
          age: 28,
          city: "New York",
        },
      },
    });

    const result = safeJSONParse(validNestedJson, NestedSchema);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        user: {
          name: "Alice",
          details: {
            age: 28,
            city: "New York",
          },
        },
      });
    }
  });

  it("returns error when nested validation fails", () => {
    const NestedSchema = z.object({
      user: z.object({
        name: z.string(),
        age: z.number(),
      }),
    });

    const invalidNestedJson = '{"user": {"name": "Bob", "age": "invalid"}}';
    const result = safeJSONParse(invalidNestedJson, NestedSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("handles strict schemas that reject extra properties", () => {
    const StrictSchema = z
      .object({
        name: z.string(),
      })
      .strict();

    const jsonWithExtraProps = '{"name": "John", "age": 30}';
    const result = safeJSONParse(jsonWithExtraProps, StrictSchema);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("handles union schemas", () => {
    const UnionSchema = z.union([
      z.object({ type: z.literal("user"), name: z.string() }),
      z.object({ type: z.literal("admin"), permissions: z.array(z.string()) }),
    ]);

    const userJson = '{"type": "user", "name": "John"}';
    const userResult = safeJSONParse(userJson, UnionSchema);

    expect(userResult.success).toBe(true);
    if (userResult.success) {
      expect(userResult.data).toEqual({ type: "user", name: "John" });
    }

    const adminJson = '{"type": "admin", "permissions": ["read", "write"]}';
    const adminResult = safeJSONParse(adminJson, UnionSchema);

    expect(adminResult.success).toBe(true);
    if (adminResult.success) {
      expect(adminResult.data).toEqual({
        type: "admin",
        permissions: ["read", "write"],
      });
    }
  });

  it.each([
    ['{"name": "John", "age":}'],
    ['{name: "John"}'],
    ['{"name": "John"'],
    [""],
    ["hello world"],
  ])("returns error for invalid JSON %s", (invalidJson) => {
    const result = safeJSONParse(invalidJson, UserSchema);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });
});
