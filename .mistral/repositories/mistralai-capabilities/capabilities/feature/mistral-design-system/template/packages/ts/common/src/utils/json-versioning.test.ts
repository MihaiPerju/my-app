import type { StandardSchemaV1 } from "@standard-schema/spec";
import * as Schema from "effect/Schema";
import { describe, expect, expectTypeOf, it } from "vitest";
import z from "zod";

import { JsonVersioning, JsonVersioningError } from "./json-versioning";

const schemaV1 = z.object({
  version: z.literal(1),
  name: z.string(),
});

const schemaV2 = z.object({
  version: z.literal(2),
  fullName: z.string(),
});

const schemaV3 = z.object({
  version: z.literal(3),
  profile: z.object({
    fullName: z.string(),
  }),
});

describe("JsonVersioning", () => {
  it("parses payload with explicit version key", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    const parsed = versioning.parse({
      version: 2,
      fullName: "Ada Lovelace",
    });

    expect(parsed).toMatchObject({
      version: 2,
      value: {
        version: 2,
        fullName: "Ada Lovelace",
      },
    });
  });

  it("detects version from schemas when version key is absent", () => {
    const v1Schema = z.object({
      kind: z.literal("legacy"),
      value: z.string(),
    });
    const v2Schema = z.object({
      kind: z.literal("modern"),
      value: z.string(),
    });

    const versioning = new JsonVersioning({ versionKey: "schemaVersion" })
      .addVersion(1, v1Schema)
      .addVersion(2, v2Schema, (v1) => ({
        kind: "modern" as const,
        value: v1.value,
      }));

    const parsed = versioning.parse({
      kind: "modern",
      value: "x",
    });

    expect(parsed).toMatchObject({
      version: 2,
      isLatest: true,
    });
  });

  it("migrates old payloads to latest schema", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }))
      .addVersion(3, schemaV3, (v2) => ({
        version: 3 as const,
        profile: { fullName: v2.fullName },
      }));

    const migrated = versioning.toLatest({
      version: 1,
      name: "Ada Lovelace",
    });

    expect(migrated).toEqual({
      version: 3,
      profile: {
        fullName: "Ada Lovelace",
      },
    });
  });

  it("supports Effect Schema through Standard Schema", () => {
    const effectSchemaV2 = Schema.toStandardSchemaV1(
      Schema.Struct({
        version: Schema.Literal(2),
        fullName: Schema.String,
      }),
    );

    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, effectSchemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    expect(versioning.toLatest({ version: 1, name: "Ada Lovelace" })).toEqual({
      version: 2,
      fullName: "Ada Lovelace",
    });

    expect(() => versioning.parse({ version: 2, fullName: 42 })).toThrowError(
      JsonVersioningError,
    );
  });

  it("rejects async Standard Schema validators", () => {
    const asyncSchema: StandardSchemaV1<unknown, { version: 1 }> = {
      "~standard": {
        version: 1,
        vendor: "test",
        validate: async () => ({ value: { version: 1 } }),
      },
    };
    const versioning = new JsonVersioning().addVersion(1, asyncSchema);

    expect(() => versioning.parseLatest({ version: 1 })).toThrowError(
      new JsonVersioningError(
        "Async Standard Schema validation is not supported.",
      ),
    );
  });

  it("auto-updates versionKey after migration step", () => {
    const versioning = new JsonVersioning()
      .addVersion(
        1,
        z.object({
          version: z.literal(1),
          title: z.string(),
        }),
      )
      .addVersion(
        2,
        z.object({
          version: z.literal(2),
          title: z.string(),
          slug: z.string(),
        }),
        (v1) => ({
          version: 2 as const,
          title: v1.title,
          slug: v1.title.toLowerCase().replaceAll(" ", "-"),
        }),
      );

    const migrated = versioning.toLatest({
      version: 1,
      title: "Hello World",
    });

    expect(migrated).toEqual({
      version: 2,
      title: "Hello World",
      slug: "hello-world",
    });
  });

  it("detects version from schemas when version key is not present", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, z.object({ type: z.literal("legacy"), value: z.string() }))
      .addVersion(
        2,
        z.object({ type: z.literal("modern"), value: z.string() }),
        (v1) => ({ type: "modern" as const, value: v1.value }),
      );

    const parsed = versioning.parse({ type: "legacy", value: "x" });
    expect(parsed.version).toBe(1);
    expect(parsed.isLatest).toBe(false);
  });

  it("discriminates parse result with isLatest", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    expect(versioning.parse({ version: 1, name: "Ada Lovelace" })).toEqual({
      version: 1,
      value: { version: 1, name: "Ada Lovelace" },
      isLatest: false,
    });
    expect(versioning.parse({ version: 2, fullName: "Ada Lovelace" })).toEqual({
      version: 2,
      value: { version: 2, fullName: "Ada Lovelace" },
      isLatest: true,
    });
  });

  it("returns true when payload matches latest schema", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    expect(versioning.isLatest({ version: 2, fullName: "Ada Lovelace" })).toBe(
      true,
    );
  });

  it("returns false when payload does not match latest schema", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    expect(versioning.isLatest({ version: 1, name: "Ada Lovelace" })).toBe(
      false,
    );
  });

  it("throws when migration output does not match next schema", () => {
    const versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (_v1) => // @ts-expect-error - invalid field
      ({ version: 2, invalidField: "oops" }));

    expect(() =>
      versioning.toLatest({
        version: 1,
        name: "Ada Lovelace",
      }),
    ).toThrowError(JsonVersioningError);
  });

  it("enforces sequential version registration", () => {
    const versioning = new JsonVersioning().addVersion(1, schemaV1);

    expect(() =>
      versioning.addVersion(3, schemaV3, (_v1) => ({
        version: 3 as const,
        profile: { fullName: "Ada" },
      })),
    ).toThrowError(JsonVersioningError);
  });

  it("exposes all version types through JsonVersioning.infer", () => {
    const _versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    type Inferred = JsonVersioning.infer<typeof _versioning>;

    expectTypeOf<Inferred>().toEqualTypeOf<
      | {
          version: 1;
          name: string;
        }
      | {
          version: 2;
          fullName: string;
        }
    >();
  });

  it("exposes latest type through JsonVersioning.inferLatest", () => {
    const _versioning = new JsonVersioning()
      .addVersion(1, schemaV1)
      .addVersion(2, schemaV2, (v1) => ({
        version: 2 as const,
        fullName: v1.name,
      }));

    type InferredLatest = JsonVersioning.inferLatest<typeof _versioning>;

    expectTypeOf<InferredLatest>().toEqualTypeOf<{
      version: 2;
      fullName: string;
    }>();
  });
});
