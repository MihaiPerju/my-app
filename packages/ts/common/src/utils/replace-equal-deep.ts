/*
 * This is a modified version of the TanStack Query `replaceEqualDeep` function.
 * Source: https://github.com/TanStack/query/blob/main/packages/query-core/src/utils.ts
 *
 * The original version only handles json values, but we use superjson in many of our apps.
 *
 * CHANGES:
 * - Consider Date objects that point to the same time as equal.
 *
 * Passing this as the `structuralSharing` function of a query client means
 * that queries will benefit from structural sharing, as opposed to when using the default function
 *
 * TODO: Handle other types that superjson supports.
 */

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * Returns `a` if `b` is deeply equal, otherwise replaces any deeply equal
 * children of `b` with those of `a`. This can be used for structural sharing
 * between JSON values, which is useful for optimizing React state updates
 * and preventing unnecessary re-renders.
 *
 * @template T - The type of the second parameter and return value.
 * @param a - The reference value to compare against.
 * @param b - The value to potentially replace with `a` or its children.
 * @returns `a` if deeply equal to `b`, otherwise a new object/array with
 *          deeply equal children replaced by references from `a`.
 *
 * @example
 * ```ts
 * const oldData = { user: { id: 1, name: "Alice" } };
 * const newData = { user: { id: 1, name: "Alice" } };
 * const result = replaceEqualDeep(oldData, newData);
 * // result === oldData (same reference due to deep equality)
 * ```
 */
export function replaceEqualDeep<T>(a: unknown, b: T): T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replaceEqualDeep(a: any, b: any): any {
  if (a === b) {
    return a;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.getTime() === b.getTime() ? a : b;
  }

  const array = isPlainArray(a) && isPlainArray(b);

  if (!array && !(isPlainObject(a) && isPlainObject(b))) return b;

  const aItems = array ? a : Object.keys(a);
  const aSize = aItems.length;
  const bItems = array ? b : Object.keys(b);
  const bSize = bItems.length;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const copy: any = array ? new Array(bSize) : {};

  let equalItems = 0;

  for (let i = 0; i < bSize; i++) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const key: any = array ? i : bItems[i];
    const aItem = a[key];
    const bItem = b[key];

    if (aItem === bItem) {
      copy[key] = aItem;
      if (array ? i < aSize : hasOwn.call(a, key)) equalItems++;
      continue;
    }

    if (
      aItem === null ||
      bItem === null ||
      typeof aItem !== "object" ||
      typeof bItem !== "object"
    ) {
      copy[key] = bItem;
      continue;
    }

    const v = replaceEqualDeep(aItem, bItem);
    copy[key] = v;
    if (v === aItem) equalItems++;
  }

  return aSize === bSize && equalItems === aSize ? a : copy;
}

function isPlainArray(value: unknown): value is Array<unknown> {
  return Array.isArray(value) && value.length === Object.keys(value).length;
}

// Copied from: https://github.com/jonschlinkert/is-plain-object
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isPlainObject(o: any): o is Record<PropertyKey, unknown> {
  if (!hasObjectPrototype(o)) {
    return false;
  }

  // If has no constructor
  const ctor = o.constructor;
  if (ctor === undefined) {
    return true;
  }

  // If has modified prototype
  const prot = ctor.prototype;
  if (!hasObjectPrototype(prot)) {
    return false;
  }

  // If constructor does not have an Object-specific method
  // eslint-disable-next-line no-prototype-builtins
  if (!prot.hasOwnProperty("isPrototypeOf")) {
    return false;
  }

  // Handles Objects created by Object.create(<arbitrary prototype>)
  if (Object.getPrototypeOf(o) !== Object.prototype) {
    return false;
  }

  // Most likely a plain Object
  return true;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function hasObjectPrototype(o: any): boolean {
  return Object.prototype.toString.call(o) === "[object Object]";
}
