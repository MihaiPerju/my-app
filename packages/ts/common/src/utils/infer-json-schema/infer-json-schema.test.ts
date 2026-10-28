import { describe, expect, it } from "vitest";

import {
  inferJsonSchema,
  mergeSchemas,
  type JsonSchema,
  type JsonValue,
} from "./infer-json-schema";

describe("inferJsonSchema", () => {
  // ==========================================================================
  // Primitives
  // ==========================================================================
  describe("primitives", () => {
    it("infers null", () => {
      expect(inferJsonSchema(null)).toEqual({ type: "null" });
    });

    it("infers true", () => {
      expect(inferJsonSchema(true)).toEqual({ type: "boolean" });
    });

    it("infers false", () => {
      expect(inferJsonSchema(false)).toEqual({ type: "boolean" });
    });

    it("infers positive integer", () => {
      expect(inferJsonSchema(42)).toEqual({ type: "integer" });
    });

    it("infers zero as integer", () => {
      expect(inferJsonSchema(0)).toEqual({ type: "integer" });
    });

    it("infers negative integer", () => {
      expect(inferJsonSchema(-7)).toEqual({ type: "integer" });
    });

    it("infers float as number", () => {
      expect(inferJsonSchema(3.14)).toEqual({ type: "number" });
    });

    it("infers negative float as number", () => {
      expect(inferJsonSchema(-0.5)).toEqual({ type: "number" });
    });

    it("infers string", () => {
      expect(inferJsonSchema("hello")).toEqual({ type: "string" });
    });

    it("infers empty string", () => {
      expect(inferJsonSchema("")).toEqual({ type: "string" });
    });
  });

  // ==========================================================================
  // Empty containers
  // ==========================================================================
  describe("empty containers", () => {
    it("infers empty array", () => {
      expect(inferJsonSchema([])).toEqual({ type: "array" });
    });

    it("infers empty object", () => {
      expect(inferJsonSchema({})).toEqual({ type: "object" });
    });
  });

  // ==========================================================================
  // Arrays — homogeneous
  // ==========================================================================
  describe("homogeneous arrays", () => {
    it("infers array of integers", () => {
      expect(inferJsonSchema([1, 2, 3])).toEqual({
        type: "array",
        items: { type: "integer" },
      });
    });

    it("infers array of strings", () => {
      expect(inferJsonSchema(["a", "b", "c"])).toEqual({
        type: "array",
        items: { type: "string" },
      });
    });

    it("infers array of booleans", () => {
      expect(inferJsonSchema([true, false, true])).toEqual({
        type: "array",
        items: { type: "boolean" },
      });
    });

    it("infers array of nulls", () => {
      expect(inferJsonSchema([null, null])).toEqual({
        type: "array",
        items: { type: "null" },
      });
    });

    it("infers array of floats", () => {
      expect(inferJsonSchema([1.1, 2.2])).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("infers single-element array", () => {
      expect(inferJsonSchema([42])).toEqual({
        type: "array",
        items: { type: "integer" },
      });
    });
  });

  // ==========================================================================
  // Arrays — heterogeneous
  // ==========================================================================
  describe("heterogeneous arrays", () => {
    it("merges integer and float to number", () => {
      expect(inferJsonSchema([1, 1.5])).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("merges float and integer to number", () => {
      expect(inferJsonSchema([1.5, 1])).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("creates anyOf for integer and string", () => {
      expect(inferJsonSchema([1, "a"])).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      });
    });

    it("creates anyOf for three distinct types", () => {
      expect(inferJsonSchema([1, "a", null])).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "integer" }, { type: "string" }, { type: "null" }],
        },
      });
    });

    it("deduplicates same types across elements", () => {
      expect(inferJsonSchema([1, "a", 2, "b", 3])).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      });
    });

    it("coalesces integer into number when both appear", () => {
      expect(inferJsonSchema([1, 2.5, 3])).toEqual({
        type: "array",
        items: { type: "number" },
      });
    });

    it("handles mixed with null", () => {
      expect(inferJsonSchema([null, 42])).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "null" }, { type: "integer" }],
        },
      });
    });

    it("handles boolean and string", () => {
      expect(inferJsonSchema([true, "yes"])).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "boolean" }, { type: "string" }],
        },
      });
    });
  });

  // ==========================================================================
  // Nested arrays
  // ==========================================================================
  describe("nested arrays", () => {
    it("infers array of integer arrays", () => {
      expect(
        inferJsonSchema([
          [1, 2],
          [3, 4],
        ]),
      ).toEqual({
        type: "array",
        items: { type: "array", items: { type: "integer" } },
      });
    });

    it("merges heterogeneous nested arrays", () => {
      expect(
        inferJsonSchema([
          [1, 2],
          ["a", "b"],
        ]),
      ).toEqual({
        type: "array",
        items: {
          type: "array",
          items: {
            anyOf: [{ type: "integer" }, { type: "string" }],
          },
        },
      });
    });

    it("infers array of empty arrays", () => {
      expect(inferJsonSchema([[], []])).toEqual({
        type: "array",
        items: { type: "array" },
      });
    });

    it("merges empty array with non-empty array", () => {
      expect(inferJsonSchema([[], [1, 2]])).toEqual({
        type: "array",
        items: { type: "array", items: { type: "integer" } },
      });
    });
  });

  // ==========================================================================
  // Simple objects
  // ==========================================================================
  describe("objects", () => {
    it("infers object with one key", () => {
      expect(inferJsonSchema({ a: 1 })).toEqual({
        type: "object",
        properties: { a: { type: "integer" } },
        required: ["a"],
      });
    });

    it("infers object with multiple keys", () => {
      expect(inferJsonSchema({ name: "John", age: 30 })).toEqual({
        type: "object",
        properties: {
          name: { type: "string" },
          age: { type: "integer" },
        },
        required: ["name", "age"],
      });
    });

    it("infers object with mixed value types", () => {
      expect(inferJsonSchema({ s: "x", n: 1, b: true, nil: null })).toEqual({
        type: "object",
        properties: {
          s: { type: "string" },
          n: { type: "integer" },
          b: { type: "boolean" },
          nil: { type: "null" },
        },
        required: ["s", "n", "b", "nil"],
      });
    });

    it("infers nested objects", () => {
      expect(inferJsonSchema({ user: { name: "Alice" } })).toEqual({
        type: "object",
        properties: {
          user: {
            type: "object",
            properties: { name: { type: "string" } },
            required: ["name"],
          },
        },
        required: ["user"],
      });
    });

    it("infers object with array value", () => {
      expect(inferJsonSchema({ tags: ["a", "b"] })).toEqual({
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["tags"],
      });
    });

    it("preserves explicit properties when primitive values share a schema", () => {
      expect(inferJsonSchema({ first: 1, second: 2 })).toEqual({
        type: "object",
        properties: {
          first: { type: "integer" },
          second: { type: "integer" },
        },
        required: ["first", "second"],
      });
    });

    it("preserves explicit properties for mixed numeric values", () => {
      expect(inferJsonSchema({ first: 1, second: 2.5 })).toEqual({
        type: "object",
        properties: {
          first: { type: "integer" },
          second: { type: "number" },
        },
        required: ["first", "second"],
      });
    });

    it("infers nested record schema when values share object schemas", () => {
      expect(
        inferJsonSchema({
          first: { label: "one", enabled: true },
          second: { label: "two", enabled: false },
        }),
      ).toEqual({
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            label: { type: "string" },
            enabled: { type: "boolean" },
          },
          required: ["label", "enabled"],
        },
      });
    });

    it("infers dynamic object keys as a record schema with shared nested requirements", () => {
      expect(
        inferJsonSchema({
          product1: { name: "Laptop", price: 1200 },
          product2: { name: "Monitor" },
          product3: { name: "Mouse", stock: 12 },
        }),
      ).toEqual({
        type: "object",
        additionalProperties: {
          type: "object",
          properties: {
            name: { type: "string" },
            price: { type: "integer" },
            stock: { type: "integer" },
          },
          required: ["name"],
        },
      });
    });

    it("preserves explicit properties for homogeneous primitive objects", () => {
      expect(
        inferJsonSchema({
          id: "2b26ba59-a7fe-80c0-95ce-f1ae1ad4681d",
          title: "[eACTION] - data BOM & procurement",
          url: "https://app.notion.com/p/2b26ba59",
          type: "page",
          highlight: "**oui**",
          timestamp: "2 months ago (2026-04-03)",
        }),
      ).toEqual({
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          url: { type: "string" },
          type: { type: "string" },
          highlight: { type: "string" },
          timestamp: { type: "string" },
        },
        required: ["id", "title", "url", "type", "highlight", "timestamp"],
      });
    });
  });

  // ==========================================================================
  // Arrays of objects — schema merging
  // ==========================================================================
  describe("arrays of objects (merging)", () => {
    it("merges identical object shapes", () => {
      expect(
        inferJsonSchema([
          { a: 1, b: "x" },
          { a: 2, b: "y" },
        ]),
      ).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            a: { type: "integer" },
            b: { type: "string" },
          },
          required: ["a", "b"],
        },
      });
    });

    it("preserves primitive result object properties inside arrays", () => {
      expect(
        inferJsonSchema({
          results: [
            {
              id: "2b26ba59-a7fe-80c0-95ce-f1ae1ad4681d",
              title: "[eACTION] - data BOM & procurement",
              url: "https://app.notion.com/p/2b26ba59",
              type: "page",
              highlight: "**oui**",
              timestamp: "2 months ago (2026-04-03)",
            },
          ],
          type: "ai_search",
        }),
      ).toEqual({
        type: "object",
        properties: {
          results: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "string" },
                title: { type: "string" },
                url: { type: "string" },
                type: { type: "string" },
                highlight: { type: "string" },
                timestamp: { type: "string" },
              },
              required: [
                "id",
                "title",
                "url",
                "type",
                "highlight",
                "timestamp",
              ],
            },
          },
          type: { type: "string" },
        },
        required: ["results", "type"],
      });
    });

    it("marks keys as optional when missing from some objects", () => {
      const schema = inferJsonSchema([
        { a: 1, b: 2 },
        { a: 3, c: 4 },
      ]);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            a: { type: "integer" },
            b: { type: "integer" },
            c: { type: "integer" },
          },
          required: ["a"],
        },
      });
    });

    it("produces no required when objects share no keys", () => {
      const schema = inferJsonSchema([{ a: 1 }, { b: 2 }]);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            a: { type: "integer" },
            b: { type: "integer" },
          },
        },
      });
    });

    it("merges property value types across objects", () => {
      const schema = inferJsonSchema([{ v: 1 }, { v: "hello" }]);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            v: { anyOf: [{ type: "integer" }, { type: "string" }] },
          },
          required: ["v"],
        },
      });
    });

    it("merges homogeneous primitive objects with explicit properties", () => {
      const schema = inferJsonSchema([
        { a: 1, b: 2 },
        { a: 3, b: "hello" },
      ]);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            a: { type: "integer" },
            b: { anyOf: [{ type: "integer" }, { type: "string" }] },
          },
          required: ["a", "b"],
        },
      });
    });

    it("merges nested object properties", () => {
      const schema = inferJsonSchema([
        { meta: { x: 1 } },
        { meta: { x: 2, y: "a" } },
      ]);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            meta: {
              type: "object",
              properties: {
                x: { type: "integer" },
                y: { type: "string" },
              },
              required: ["x"],
            },
          },
          required: ["meta"],
        },
      });
    });

    it("merges three objects progressively", () => {
      const schema = inferJsonSchema([
        { a: 1, b: 2 },
        { a: 3, c: 4 },
        { a: 5, b: 6, c: 7, d: 8 },
      ]);
      expect(schema).toEqual({
        type: "array",
        items: {
          type: "object",
          properties: {
            a: { type: "integer" },
            b: { type: "integer" },
            c: { type: "integer" },
            d: { type: "integer" },
          },
          required: ["a"],
        },
      });
    });
  });

  // ==========================================================================
  // Mixed arrays (objects + primitives)
  // ==========================================================================
  describe("mixed arrays (objects and primitives)", () => {
    it("creates anyOf for object and string", () => {
      expect(inferJsonSchema([{ a: 1 }, "hello"])).toEqual({
        type: "array",
        items: {
          anyOf: [
            {
              type: "object",
              properties: { a: { type: "integer" } },
              required: ["a"],
            },
            { type: "string" },
          ],
        },
      });
    });

    it("creates anyOf for array and object", () => {
      expect(inferJsonSchema([[1, 2], { a: 3 }])).toEqual({
        type: "array",
        items: {
          anyOf: [
            { type: "array", items: { type: "integer" } },
            {
              type: "object",
              properties: { a: { type: "integer" } },
              required: ["a"],
            },
          ],
        },
      });
    });
  });

  // ==========================================================================
  // Limits — maxObjectKeys
  // ==========================================================================
  describe("maxObjectKeys", () => {
    it("limits keys visited in an object", () => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 10; i++) obj[`k${i}`] = i;

      const schema = inferJsonSchema(obj as JsonValue, { maxObjectKeys: 3 });
      expect(schema.type).toBe("object");
      expect(Object.keys(schema.properties!)).toHaveLength(3);
      expect(schema.additionalProperties).toBe(true);
    });

    it("preserves primitive properties when homogeneous object is under the limit", () => {
      const schema = inferJsonSchema({ a: 1, b: 2 }, { maxObjectKeys: 10 });
      expect(schema).toEqual({
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "integer" },
        },
        required: ["a", "b"],
      });
    });

    it("visits all keys when limit equals key count", () => {
      const schema = inferJsonSchema(
        { a: 1, b: 2, c: 3 },
        { maxObjectKeys: 3 },
      );
      expect(schema).toEqual({
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "integer" },
          c: { type: "integer" },
        },
        required: ["a", "b", "c"],
      });
    });

    it("does not infer record schema for truncated homogeneous objects", () => {
      const schema = inferJsonSchema(
        { a: 1, b: 2, c: 3 },
        { maxObjectKeys: 2 },
      );
      expect(schema).toEqual({
        type: "object",
        properties: {
          a: { type: "integer" },
          b: { type: "integer" },
        },
        required: ["a", "b"],
        additionalProperties: true,
      });
    });
  });

  // ==========================================================================
  // Limits — maxArrayElements
  // ==========================================================================
  describe("maxArrayElements", () => {
    it("samples only the first N elements", () => {
      const arr = [1, 2, 3, "a", "b", "c"];
      const schema = inferJsonSchema(arr, { maxArraySampling: 3 });
      expect(schema).toEqual({
        type: "array",
        items: { type: "integer" },
      });
    });

    it("includes types from all sampled elements", () => {
      const arr = [1, "a", true, null, 2];
      const schema = inferJsonSchema(arr, { maxArraySampling: 4 });
      expect(schema).toEqual({
        type: "array",
        items: {
          anyOf: [
            { type: "integer" },
            { type: "string" },
            { type: "boolean" },
            { type: "null" },
          ],
        },
      });
    });

    it("processes all elements when under the limit", () => {
      const schema = inferJsonSchema([1, "a"], { maxArraySampling: 100 });
      expect(schema).toEqual({
        type: "array",
        items: {
          anyOf: [{ type: "integer" }, { type: "string" }],
        },
      });
    });
  });

  // ==========================================================================
  // Limits — maxDepth
  // ==========================================================================
  describe("maxDepth", () => {
    it("returns empty schema for values beyond max depth", () => {
      const schema = inferJsonSchema({ a: { b: { c: 1 } } }, { maxDepth: 1 });
      expect(schema).toEqual({
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: {
              b: {},
            },
            required: ["b"],
          },
        },
        required: ["a"],
      });
    });

    it("handles maxDepth 0 (only root type inferred)", () => {
      const schema = inferJsonSchema({ a: 1 }, { maxDepth: 0 });
      expect(schema).toEqual({
        type: "object",
        properties: { a: {} },
        required: ["a"],
      });
    });

    it("infers primitives regardless of maxDepth", () => {
      expect(inferJsonSchema(42, { maxDepth: 0 })).toEqual({
        type: "integer",
      });
    });

    it("limits nested array depth", () => {
      const schema = inferJsonSchema([[1, 2]], { maxDepth: 1 });
      expect(schema).toEqual({
        type: "array",
        items: { type: "array", items: {} },
      });
    });

    it("fully infers within allowed depth", () => {
      const schema = inferJsonSchema({ a: { b: 1 } }, { maxDepth: 10 });
      expect(schema).toEqual({
        type: "object",
        properties: {
          a: {
            type: "object",
            properties: { b: { type: "integer" } },
            required: ["b"],
          },
        },
        required: ["a"],
      });
    });
  });

  // ==========================================================================
  // Edge cases
  // ==========================================================================
  describe("edge cases", () => {
    it("handles deeply nested structure within default limits", () => {
      let value: JsonValue = 42;
      for (let i = 0; i < 8; i++) value = { nested: value };

      const schema = inferJsonSchema(value);
      let current: JsonSchema = schema;
      for (let i = 0; i < 8; i++) {
        expect(current.type).toBe("object");
        expect(current.properties).toBeDefined();
        current = current.properties!.nested!;
      }
      expect(current).toEqual({ type: "integer" });
    });

    it("stops inference at default maxDepth for very deep structures", () => {
      let value: JsonValue = 42;
      for (let i = 0; i < 15; i++) value = { nested: value };

      const schema = inferJsonSchema(value);
      let current: JsonSchema = schema;
      let depth = 0;
      while (current.type === "object" && current.properties?.nested) {
        current = current.properties.nested;
        depth++;
      }
      expect(depth).toBeLessThanOrEqual(11);
    });

    it("handles large flat object with default limit", () => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 200; i++) obj[`key${i}`] = i;

      const schema = inferJsonSchema(obj as JsonValue);
      expect(Object.keys(schema.properties!)).toHaveLength(100);
      expect(schema.additionalProperties).toBe(true);
    });

    it("handles large array with default limit", () => {
      const arr = Array.from({ length: 100 }, (_, i) => i);
      const schema = inferJsonSchema(arr);
      expect(schema).toEqual({
        type: "array",
        items: { type: "integer" },
      });
    });

    it("handles object with null values", () => {
      expect(inferJsonSchema({ a: null, b: null })).toEqual({
        type: "object",
        properties: {
          a: { type: "null" },
          b: { type: "null" },
        },
        required: ["a", "b"],
      });
    });

    it("handles array of empty objects", () => {
      expect(inferJsonSchema([{}, {}])).toEqual({
        type: "array",
        items: { type: "object" },
      });
    });

    it("handles array of empty arrays", () => {
      expect(inferJsonSchema([[], []])).toEqual({
        type: "array",
        items: { type: "array" },
      });
    });

    it("handles complex real-world-like structure", () => {
      const data = {
        users: [
          { id: 1, name: "Alice", email: "alice@example.com" },
          { id: 2, name: "Bob", email: "bob@example.com", admin: true },
        ],
        meta: { total: 2, page: 1 },
      };

      const schema = inferJsonSchema(data as JsonValue);
      expect(schema).toEqual({
        type: "object",
        properties: {
          users: {
            type: "array",
            items: {
              type: "object",
              properties: {
                id: { type: "integer" },
                name: { type: "string" },
                email: { type: "string" },
                admin: { type: "boolean" },
              },
              required: ["id", "name", "email"],
            },
          },
          meta: {
            type: "object",
            properties: {
              total: { type: "integer" },
              page: { type: "integer" },
            },
            required: ["total", "page"],
          },
        },
        required: ["users", "meta"],
      });
    });
  });

  // ==========================================================================
  // mergeSchemas (exported utility)
  // ==========================================================================
  describe("mergeSchemas", () => {
    it("returns the same reference for identical schemas", () => {
      const s: JsonSchema = { type: "integer" };
      expect(mergeSchemas(s, s)).toBe(s);
    });

    it("returns b when a is empty", () => {
      const b: JsonSchema = { type: "string" };
      expect(mergeSchemas({}, b)).toBe(b);
    });

    it("returns a when b is empty", () => {
      const a: JsonSchema = { type: "string" };
      expect(mergeSchemas(a, {})).toBe(a);
    });

    it("merges integer + number → number", () => {
      expect(mergeSchemas({ type: "integer" }, { type: "number" })).toEqual({
        type: "number",
      });
    });

    it("merges number + integer → number", () => {
      expect(mergeSchemas({ type: "number" }, { type: "integer" })).toEqual({
        type: "number",
      });
    });

    it("creates anyOf for incompatible types", () => {
      expect(mergeSchemas({ type: "string" }, { type: "boolean" })).toEqual({
        anyOf: [{ type: "string" }, { type: "boolean" }],
      });
    });

    it("merges anyOf with a new type", () => {
      const anyOf: JsonSchema = {
        anyOf: [{ type: "string" }, { type: "boolean" }],
      };
      expect(mergeSchemas(anyOf, { type: "integer" })).toEqual({
        anyOf: [{ type: "string" }, { type: "boolean" }, { type: "integer" }],
      });
    });

    it("merges anyOf with an existing type (no duplicates)", () => {
      const anyOf: JsonSchema = {
        anyOf: [{ type: "string" }, { type: "integer" }],
      };
      expect(mergeSchemas(anyOf, { type: "string" })).toEqual({
        anyOf: [{ type: "string" }, { type: "integer" }],
      });
    });

    it("coalesces integer in anyOf when number is added", () => {
      const anyOf: JsonSchema = {
        anyOf: [{ type: "integer" }, { type: "string" }],
      };
      expect(mergeSchemas(anyOf, { type: "number" })).toEqual({
        anyOf: [{ type: "number" }, { type: "string" }],
      });
    });

    it("merges two anyOf schemas", () => {
      const a: JsonSchema = {
        anyOf: [{ type: "string" }, { type: "integer" }],
      };
      const b: JsonSchema = {
        anyOf: [{ type: "boolean" }, { type: "null" }],
      };
      expect(mergeSchemas(a, b)).toEqual({
        anyOf: [
          { type: "string" },
          { type: "integer" },
          { type: "boolean" },
          { type: "null" },
        ],
      });
    });

    it("unwraps anyOf with single variant", () => {
      const a: JsonSchema = { anyOf: [{ type: "integer" }] };
      expect(mergeSchemas(a, { type: "number" })).toEqual({
        type: "number",
      });
    });

    it("merges object schemas with overlapping keys", () => {
      const a: JsonSchema = {
        type: "object",
        properties: { x: { type: "integer" }, y: { type: "string" } },
        required: ["x", "y"],
      };
      const b: JsonSchema = {
        type: "object",
        properties: { x: { type: "integer" }, z: { type: "boolean" } },
        required: ["x", "z"],
      };
      expect(mergeSchemas(a, b)).toEqual({
        type: "object",
        properties: {
          x: { type: "integer" },
          y: { type: "string" },
          z: { type: "boolean" },
        },
        required: ["x"],
      });
    });

    it("merges object schemas where property types differ", () => {
      const a: JsonSchema = {
        type: "object",
        properties: { v: { type: "integer" } },
        required: ["v"],
      };
      const b: JsonSchema = {
        type: "object",
        properties: { v: { type: "string" } },
        required: ["v"],
      };
      expect(mergeSchemas(a, b)).toEqual({
        type: "object",
        properties: {
          v: { anyOf: [{ type: "integer" }, { type: "string" }] },
        },
        required: ["v"],
      });
    });

    it("propagates additionalProperties through merges", () => {
      const a: JsonSchema = {
        type: "object",
        properties: { x: { type: "integer" } },
        additionalProperties: true,
      };
      const b: JsonSchema = {
        type: "object",
        properties: { y: { type: "string" } },
      };
      expect(mergeSchemas(a, b).additionalProperties).toBe(true);
    });

    it("uses additionalProperties schema when merging explicit properties", () => {
      const a: JsonSchema = {
        type: "object",
        additionalProperties: { type: "integer" },
      };
      const b: JsonSchema = {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
      };
      expect(mergeSchemas(a, b)).toEqual({
        type: "object",
        properties: {
          value: { anyOf: [{ type: "integer" }, { type: "string" }] },
        },
        additionalProperties: { type: "integer" },
      });
    });

    it("merges two array schemas", () => {
      const a: JsonSchema = {
        type: "array",
        items: { type: "integer" },
      };
      const b: JsonSchema = {
        type: "array",
        items: { type: "string" },
      };
      expect(mergeSchemas(a, b)).toEqual({
        type: "array",
        items: { anyOf: [{ type: "integer" }, { type: "string" }] },
      });
    });

    it("merges array schema with empty array schema", () => {
      const a: JsonSchema = { type: "array" };
      const b: JsonSchema = { type: "array", items: { type: "integer" } };
      expect(mergeSchemas(a, b)).toEqual(b);
    });
  });

  // ==========================================================================
  // Performance sanity check
  // ==========================================================================
  describe("performance", () => {
    it("handles 10k-element array within default limits without stack overflow", () => {
      const arr = Array.from({ length: 10_000 }, (_, i) =>
        i % 2 === 0 ? i : String(i),
      );
      const schema = inferJsonSchema(arr);
      expect(schema.type).toBe("array");
      expect(schema.items?.anyOf).toHaveLength(2);
    });

    it("handles wide object (1000 keys) with default limit", () => {
      const obj: Record<string, number> = {};
      for (let i = 0; i < 1000; i++) obj[`k${i}`] = i;

      const schema = inferJsonSchema(obj as JsonValue);
      expect(Object.keys(schema.properties!)).toHaveLength(100);
      expect(schema.additionalProperties).toBe(true);
    });
  });

  // ==========================================================================
  // Combined limits
  // ==========================================================================
  describe("combined limits", () => {
    it("applies all limits simultaneously", () => {
      const deepObj: Record<string, unknown> = {};
      let current = deepObj;
      for (let i = 0; i < 5; i++) {
        const child: Record<string, unknown> = {};
        for (let j = 0; j < 10; j++) child[`k${j}`] = j;
        current.nested = child;
        current = child;
      }

      const schema = inferJsonSchema(deepObj as JsonValue, {
        maxDepth: 3,
        maxObjectKeys: 5,
        maxArraySampling: 2,
      });

      expect(schema.type).toBe("object");
      const nestedProps = schema.properties!.nested!;
      expect(Object.keys(nestedProps.properties!).length).toBeLessThanOrEqual(
        5,
      );
      expect(nestedProps.additionalProperties).toBe(true);
    });
  });
});
