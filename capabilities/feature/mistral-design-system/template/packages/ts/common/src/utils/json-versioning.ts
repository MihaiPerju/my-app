import type { StandardSchemaV1 } from "@standard-schema/spec";
import { isPromise } from "remeda";

type AnySchema = StandardSchemaV1<unknown, unknown>;

export type JsonVersionDefinition<
  Version extends number = number,
  Schema extends AnySchema = AnySchema,
> = {
  version: Version;
  schema: Schema;
};

type VersionMigration = {
  bivarianceHack(input: unknown): unknown;
}["bivarianceHack"];
type SchemaByVersion = Record<number, AnySchema>;
type KnownVersion<TSchemas extends SchemaByVersion> = Extract<
  keyof TSchemas,
  number
>;
type SchemaValue<Schema extends AnySchema> =
  StandardSchemaV1.InferOutput<Schema>;
type LatestValue<TLatestSchema> = TLatestSchema extends AnySchema
  ? SchemaValue<TLatestSchema>
  : never;
type ParsedValueWithLatestDiscriminant<
  TSchemas extends SchemaByVersion,
  TLatestVersion extends number,
  TLatestSchema extends AnySchema | null,
> = [KnownVersion<TSchemas>] extends [never]
  ? { version: number; value: unknown; isLatest: boolean }
  : {
      [TVersion in KnownVersion<TSchemas>]: TVersion extends TLatestVersion
        ? {
            version: TVersion;
            value: LatestValue<TLatestSchema>;
            isLatest: true;
          }
        : {
            version: TVersion;
            value: SchemaValue<TSchemas[TVersion]>;
            isLatest: false;
          };
    }[KnownVersion<TSchemas>];

type BuildTuple<
  Length extends number,
  Tuple extends unknown[] = [],
> = Tuple["length"] extends Length
  ? Tuple
  : BuildTuple<Length, [...Tuple, unknown]>;

type Decrement<N extends number> = number extends N
  ? number
  : BuildTuple<N> extends [unknown, ...infer Rest]
    ? Rest["length"]
    : never;

type InferSchemaByVersion<
  TSchemas extends SchemaByVersion,
  TVersion extends number,
> = TVersion extends keyof TSchemas ? SchemaValue<TSchemas[TVersion]> : never;

type PreviousVersionInput<
  TSchemas extends SchemaByVersion,
  TVersion extends number,
> = number extends TVersion
  ? unknown
  : InferSchemaByVersion<TSchemas, Decrement<TVersion>>;

export type JsonVersioningOptions = {
  versionKey?: string;
};

export class JsonVersioningError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonVersioningError";
  }
}

export class JsonVersioning<
  TSchemas extends SchemaByVersion = Record<never, never>,
  TLatestSchema extends AnySchema | null = null,
  TLatestVersion extends number = never,
> {
  readonly versionKey: string;

  private readonly schemaByVersion = new Map<number, AnySchema>();
  private readonly migrationByVersion = new Map<number, VersionMigration>();

  constructor({ versionKey = "version" }: JsonVersioningOptions = {}) {
    this.versionKey = versionKey;
  }

  get versions(): KnownVersion<TSchemas>[] {
    return Array.from(this.schemaByVersion.keys()).sort(
      (a, b) => a - b,
    ) as KnownVersion<TSchemas>[];
  }

  get latest(): {
    version: TLatestVersion;
    schema: TLatestSchema extends AnySchema ? TLatestSchema : AnySchema;
  } {
    const latestVersion = this.versions.at(-1);
    if (latestVersion === undefined) {
      throw new JsonVersioningError("At least one version schema is required.");
    }

    const latestSchema = this.schemaByVersion.get(latestVersion);
    if (!latestSchema) {
      throw new JsonVersioningError("Missing schema for latest version.");
    }

    return {
      version: latestVersion as unknown as TLatestVersion,
      schema: latestSchema as TLatestSchema extends AnySchema
        ? TLatestSchema
        : AnySchema,
    };
  }

  addVersion<Schema extends AnySchema>(
    version: 1,
    schema: Schema,
  ): JsonVersioning<TSchemas & Record<1, Schema>, Schema, 1>;
  addVersion<Version extends number, Schema extends AnySchema>(
    version: Version,
    schema: Schema,
    migration: (
      input: PreviousVersionInput<TSchemas, Version>,
    ) => SchemaValue<Schema>,
  ): JsonVersioning<TSchemas & Record<Version, Schema>, Schema, Version>;
  addVersion(
    version: number,
    schema: AnySchema,
    migration?: VersionMigration,
  ): unknown {
    assertIntegerVersion(version);

    if (this.schemaByVersion.has(version)) {
      throw new JsonVersioningError(
        `Duplicate schema definition for version ${version}.`,
      );
    }

    const latestVersion = this.versions.at(-1);
    if (latestVersion === undefined && version !== 1) {
      throw new JsonVersioningError("First registered version must be 1.");
    }

    if (latestVersion !== undefined && version !== latestVersion + 1) {
      throw new JsonVersioningError(
        `Version ${version} must be added after ${latestVersion}.`,
      );
    }

    if (version > 1 && !migration) {
      throw new JsonVersioningError(
        `Version ${version} requires a migration from v${version - 1}.`,
      );
    }
    if (version === 1 && migration) {
      throw new JsonVersioningError("Version 1 cannot define a migration.");
    }

    this.schemaByVersion.set(version, schema);
    if (migration) {
      this.migrationByVersion.set(version - 1, migration);
    }
    return this as unknown as JsonVersioning<
      TSchemas & SchemaByVersion,
      AnySchema,
      number
    >;
  }

  parse(
    input: unknown,
  ): ParsedValueWithLatestDiscriminant<
    TSchemas,
    TLatestVersion,
    TLatestSchema
  > {
    const version = this.getVersion(input);
    if (version === null) {
      throw new JsonVersioningError(
        `Unable to detect schema version. Provide "${this.versionKey}" in payload.`,
      );
    }

    const schema = this.schemaByVersion.get(version);
    if (!schema) {
      throw new JsonVersioningError(
        `Unsupported version ${version}. Available versions: ${this.versions.join(", ")}.`,
      );
    }

    const parsed = validateSchema(schema, input);
    if (parsed.issues) {
      throw new JsonVersioningError(
        `Payload does not match schema v${version}: ${JSON.stringify(parsed.issues)}`,
      );
    }

    const isLatest = version === this.latest.version;

    return {
      version,
      value: parsed.value,
      isLatest,
    } as ParsedValueWithLatestDiscriminant<
      TSchemas,
      TLatestVersion,
      TLatestSchema
    >;
  }

  parseLatest(input: unknown): LatestValue<TLatestSchema> {
    const parsed = validateSchema(this.latest.schema, input);
    if (parsed.issues) {
      throw new JsonVersioningError(
        `Payload does not match latest schema v${this.latest.version}: ${JSON.stringify(parsed.issues)}`,
      );
    }

    return parsed.value as LatestValue<TLatestSchema>;
  }

  isLatest(input: unknown): input is LatestValue<TLatestSchema> {
    return !validateSchema(this.latest.schema, input).issues;
  }

  toLatest(input: unknown): LatestValue<TLatestSchema> {
    const parsed = this.parse(input);
    const latestVersion = this.latest.version;

    if (parsed.isLatest) {
      return parsed.value as LatestValue<TLatestSchema>;
    }

    let currentVersion = parsed.version;
    let currentValue = parsed.value;

    while (currentVersion < latestVersion) {
      const migration = this.migrationByVersion.get(currentVersion);
      if (!migration) {
        throw new JsonVersioningError(
          `Missing migration from v${currentVersion} to v${currentVersion + 1}.`,
        );
      }

      const nextVersion = currentVersion + 1;
      const migratedValue = migration(currentValue);
      const normalizedValue = normalizeVersionKey(
        migratedValue,
        this.versionKey,
        nextVersion,
      );

      const nextSchema = this.schemaByVersion.get(nextVersion);
      if (!nextSchema) {
        throw new JsonVersioningError(
          `Missing schema for version ${nextVersion}.`,
        );
      }

      const parsedNext = validateSchema(nextSchema, normalizedValue);
      if (parsedNext.issues) {
        throw new JsonVersioningError(
          `Migration v${currentVersion}->v${nextVersion} returned invalid payload: ${JSON.stringify(parsedNext.issues)}`,
        );
      }

      currentValue = parsedNext.value;
      currentVersion = nextVersion;
    }

    return currentValue as LatestValue<TLatestSchema>;
  }

  private getVersion(input: unknown): number | null {
    return (
      extractVersionFromKey(input, this.versionKey) ??
      inferVersionFromSchemas(input, this.schemaByVersion)
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-namespace
export namespace JsonVersioning {
  export type infer<TVersioning> =
    TVersioning extends JsonVersioning<
      infer TSchemas,
      infer _TLatestSchema,
      infer _TLatestVersion
    >
      ? TSchemas extends SchemaByVersion
        ? SchemaValue<TSchemas[Extract<keyof TSchemas, number>]>
        : never
      : never;

  export type inferLatest<TVersioning> =
    TVersioning extends JsonVersioning<
      infer _TSchemas,
      infer TLatestSchema,
      infer _TLatestVersion
    >
      ? TLatestSchema extends AnySchema
        ? SchemaValue<TLatestSchema>
        : never
      : never;
}

function assertIntegerVersion(version: number): void {
  if (!Number.isInteger(version)) {
    throw new JsonVersioningError(
      `Version "${version}" is not an integer. Versions must be integer numbers.`,
    );
  }
}

function extractVersionFromKey(
  input: unknown,
  versionKey: string,
): number | null {
  if (!isPlainObject(input)) {
    return null;
  }

  const value = input[versionKey];
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function inferVersionFromSchemas(
  input: unknown,
  schemaByVersion: ReadonlyMap<number, AnySchema>,
): number | null {
  return (
    Array.from(schemaByVersion.entries())
      .reverse()
      .find(([, schema]) => !validateSchema(schema, input).issues)?.[0] ?? null
  );
}

function validateSchema<Schema extends AnySchema>(
  schema: Schema,
  input: unknown,
): StandardSchemaV1.Result<SchemaValue<Schema>> {
  const result = schema["~standard"].validate(input);

  if (isPromise(result)) {
    throw new JsonVersioningError(
      "Async Standard Schema validation is not supported.",
    );
  }

  return result;
}

function normalizeVersionKey(
  input: unknown,
  versionKey: string,
  version: number,
): unknown {
  return isPlainObject(input) ? { ...input, [versionKey]: version } : input;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  if (typeof input !== "object" || input === null) {
    return false;
  }

  const prototype = Object.getPrototypeOf(input);
  return prototype === Object.prototype || prototype === null;
}
