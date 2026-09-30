export function isString(value: string | number): value is string {
  return typeof value === "string";
}

export function hasGlobal(): boolean {
  return typeof globalThis !== "undefined";
}

export function inspect(value: readonly number[] | number): boolean {
  if (Array.isArray(value)) {
    return value.length > 0;
  }
  return value === null;
}
