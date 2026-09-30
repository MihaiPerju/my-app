export function enrich(cause: unknown): Error {
  return new Error("failed", { cause });
}

export function isThing(value: unknown): value is Thing {
  return typeof value === "object" && value !== null;
}

export function ordinary(value: string): number {
  return value.length;
}

type Thing = { id: string };

export type { Thing };
