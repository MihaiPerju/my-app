export function handleValue(value: unknown): void {}

export const handleArrow = (value: unknown): void => {};

export interface Handler {
  handle(value: unknown): void;
}

export function handleUnion(value: (string | unknown)): void {}
