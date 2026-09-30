export function classify(input: string | number): string {
  if (typeof input === "string") {
    return "text";
  }
  return "number";
}

export function checkBoolean(input: string | number): boolean {
  return typeof input === "string";
}

export const checkArrow = (input: string | number): boolean =>
  typeof input === "number";
