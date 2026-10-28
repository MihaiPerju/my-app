import * as jsonpatch from "fast-json-patch";
import * as mutative from "mutative";
import { isMatching, P } from "ts-pattern";
import { z } from "zod";

type Literal = null | boolean | number | string;

const isLiteral = (value: unknown): value is Literal => {
  return (
    value === null ||
    typeof value === "boolean" ||
    typeof value === "number" ||
    typeof value === "string"
  );
};

type MutativePatch = Omit<
  mutative.Patch<{
    pathAsArray: false;
    arrayLengthAssignment: false;
  }>,
  "path"
  // for some reason, path is `[]` when setting at the root level.
  // mutative types are incorrect.
> & { path: string | [] };

/**
 * The brand is used to make sure you can't mix patches of different types,
 * and mistakenly apply a patch to the wrong object.
 */
const brand = Symbol("@patch/brand");

export type RootPatch<T> = { op: "replace"; path: "/"; value: T };

type AppendTextPatch<T = object> = {
  op: "append";
  path: string;
  value: string;
  [brand]?: T;
};

type BasePatch<T> = {
  op: "replace" | "add" | "remove";
  path: string;
  value: unknown;
  [brand]?: T;
};

export type Patch<T = object> = BasePatch<T> | AppendTextPatch | RootPatch<T>;

/**
 * Build the wire schema for patches targeting a specific root value.
 *
 * Only a root replacement can validate its value against the complete state
 * schema. Values at arbitrary JSON Pointer paths intentionally remain unknown.
 */
export function createPatchSchema<RootSchema extends z.ZodType>(
  rootSchema: RootSchema,
): z.ZodType<Patch<z.output<RootSchema>>> {
  const nonRootPathSchema = z
    .string()
    .min(1)
    .refine((path) => path !== "/", {
      message: "Root patches must replace the complete root value",
    });

  return z.union([
    z.object({
      op: z.literal("replace"),
      path: z.literal("/"),
      value: rootSchema,
    }),
    z.object({
      op: z.literal("append"),
      path: nonRootPathSchema,
      value: z.string(),
    }),
    z.object({
      op: z.enum(["replace", "add"]),
      path: nonRootPathSchema,
      value: z.unknown(),
    }),
    z.object({
      op: z.literal("remove"),
      path: nonRootPathSchema,
      value: z.unknown().optional(),
    }),
  ]) as z.ZodType<Patch<z.output<RootSchema>>>;
}

export type Draft<T> = mutative.Draft<T>;

function applyPatch<T>(state: T, patch: Patch<T>): T;
function applyPatch(state: object, patch: Patch): object {
  const updates = removeAppendTextPatch<object>(state, [patch]);
  const update = updates[0];
  if (!update) return state;
  return isRootPatch<object>(update)
    ? update.value
    : mutative.apply(state, [update]);
}

/**
 * Apply patches to a state object and return a new state.
 */
export function apply<T>(state: T, patches: Patch<T>[]): T;
export function apply(state: object, patches: Patch[]): object {
  return patches.reduce(applyPatch, state);
}

/**
 * use imperative mutation to return a new value and the patches applied.
 */
export const produce = <T>(
  value: T,
  mutation: (draft: mutative.Draft<T>) => void,
): [T, Patch<T>[]] => {
  const [newValue, patches] = mutative.create(value, mutation, {
    enablePatches: {
      pathAsArray: false,
      arrayLengthAssignment: false,
    },
  });
  return [newValue, stringifyPath(addAppendTextPatch(value, patches))];
};

/**
 * is this patch completely replacing the root value?
 */
export const isRootPatch = <T>(
  patch: Patch<T> | object,
): patch is RootPatch<T> => {
  return isMatching({ op: "replace", path: P.union("", "/", []) }, patch);
};

export const createRootPatch = <T>(value: T): RootPatch<T> => {
  return { op: "replace", path: "/", value };
};

/**
 * Internal helpers
 */

const getAtPath = <T>(path: string, value: T): unknown => {
  const pathParts = path.split("/").filter(Boolean);
  return pathParts.reduce<unknown>((acc, part) => {
    if (acc && typeof acc === "object" && part in acc) {
      return acc[part as keyof typeof acc];
    }
    return undefined;
  }, value);
};

const addAppendTextPatch = <T>(
  oldState: T,
  patches: MutativePatch[],
): Patch<T>[] => {
  return patches.map((patch): Patch<T> => {
    if (patch.op !== "replace") return patch as Patch<T>;
    if (typeof patch.path !== "string") return patch as Patch<T>;
    if (typeof patch.value !== "string") return patch as Patch<T>;

    const oldValue = getAtPath(patch.path, oldState);

    if (typeof oldValue !== "string") return patch as Patch<T>;
    if (!patch.value.startsWith(oldValue)) return patch as Patch<T>;

    return {
      op: "append",
      path: patch.path,
      value: patch.value.slice(oldValue.length),
    } as Patch<T>;
  });
};

const removeAppendTextPatch = <T>(
  oldState: T,
  patches: Patch<T>[],
): Exclude<Patch<T>, AppendTextPatch>[] => {
  return patches.flatMap((patch): Exclude<Patch<T>, AppendTextPatch> | [] => {
    if (patch.op !== "append") return patch;

    const oldValue = getAtPath(patch.path, oldState);
    if (typeof oldValue !== "string") return [];

    return {
      op: "replace",
      path: patch.path,
      value: oldValue + patch.value,
    };
  });
};

export const stringifyPath = <T>(patches: Patch<T>[]): Patch<T>[] => {
  // don't clone array if all paths are strings
  if (patches.every((patch) => !Array.isArray(patch.path))) {
    return patches;
  }

  return patches.map((patch) =>
    Array.isArray(patch.path)
      ? { ...patch, path: `/${patch.path.join("/")}` }
      : patch,
  );
};

export const rawReturn = mutative.rawReturn;

/**
 * This create a list of patches from two object states.
 * Note that you can get "append" operations using this function.
 */
export function diff<T>(oldState: T | undefined, newState: T): Patch<T>[];
export function diff(
  oldState: object | Literal | undefined,
  newState: object | Literal,
): Patch<object | Literal>[] {
  if (oldState === undefined) {
    return [{ op: "replace", path: "/", value: newState }];
  }

  const patches: MutativePatch[] =
    isLiteral(newState) || isLiteral(oldState)
      ? [{ op: "replace", path: "/", value: newState }]
      : (jsonpatch.compare(oldState, newState) as MutativePatch[]);

  return addAppendTextPatch(oldState, patches);
}
