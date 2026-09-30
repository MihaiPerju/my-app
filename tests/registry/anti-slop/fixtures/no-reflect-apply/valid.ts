export function callDirect(fn: (n: number) => number, n: number): number {
  return fn(n);
}

export function probe(target: { key: number }): boolean {
  return Reflect.has(target, "key");
}

export function shadowed(): number {
  const Reflect = { apply: (n: number): number => n };
  return Reflect.apply(1);
}
