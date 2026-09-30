import Ajv from "ajv";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { validateJsonSchemaPayload } from "./validate-json-schema";

describe("validateJsonSchemaPayload", () => {
  it("validates JSON Schema 2020-12 payloads produced by z.toJSONSchema", () => {
    const schema = z.toJSONSchema(
      z.object({
        confirmation: z.enum(["allow", "deny"]),
      }),
    );

    const validation = validateJsonSchemaPayload({
      schema,
      input: { confirmation: "allow" },
    });

    expect(validation).toEqual({
      isValid: true,
      value: { confirmation: "allow" },
    });
  });

  it("reports invalid input instead of invalid schema for JSON Schema 2020-12 payloads", () => {
    const schema = z.toJSONSchema(
      z.object({
        confirmation: z.enum(["allow", "deny"]),
      }),
    );

    const validation = validateJsonSchemaPayload({
      schema,
      input: { confirmation: "maybe" },
    });

    expect(validation.isValid).toBe(false);
    if (validation.isValid) {
      throw new Error("Expected validation to fail");
    }
    expect(validation.errorType).toBe("invalid-input");
  });

  it("validates primitive payloads", () => {
    const validation = validateJsonSchemaPayload({
      schema: { type: "string" },
      input: "ready",
    });

    expect(validation).toEqual({
      isValid: true,
      value: "ready",
    });
  });

  it("returns invalid-schema for an uncompilable schema", () => {
    // Ajv throws when an unknown $ref format is used as a type constraint.
    const validation = validateJsonSchemaPayload({
      schema: { type: "totally-unknown-type" as "string" },
      input: "anything",
    });

    expect(validation.isValid).toBe(false);
    if (validation.isValid) throw new Error("Expected validation to fail");
    expect(validation.errorType).toBe("invalid-schema");
  });

  it("keeps enforcing the constraint behind an errorMessage extension", () => {
    // Workflow form schemas carry `errorMessage` for the browser to render.
    // Strict mode would otherwise reject the whole schema as uncompilable.
    const schema = {
      type: "object",
      properties: {
        booking: {
          type: "string",
          pattern: "^00\\d{8}$",
          errorMessage: { pattern: "Booking reference is malformed" },
        },
      },
    } as const;

    expect(
      validateJsonSchemaPayload({ schema, input: { booking: "0012345678" } }),
    ).toEqual({ isValid: true, value: { booking: "0012345678" } });

    const rejected = validateJsonSchemaPayload({
      schema,
      input: { booking: "nope" },
    });

    expect(rejected.isValid).toBe(false);
    if (rejected.isValid) throw new Error("Expected validation to fail");
    expect(rejected.errorType).toBe("invalid-input");
  });

  it("reuses the compiled validator for repeated calls with the same schema object", () => {
    const spy = vi.spyOn(Ajv.prototype, "compile");

    // Use a fresh object reference so no prior test has already cached it.
    const schema = { type: "number", description: "caching-test" } as const;
    validateJsonSchemaPayload({ schema, input: 1 });
    validateJsonSchemaPayload({ schema, input: 2 });
    validateJsonSchemaPayload({ schema, input: 3 });

    // compile() should have been called exactly once regardless of how many
    // times we validate against the same schema object.
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockRestore();
  });
});
