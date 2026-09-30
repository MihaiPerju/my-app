export function invoke(fn: (n: number) => number, n: number): number {
  const direct = Reflect.apply(fn, undefined, [n]);
  const computed = Reflect["apply"](fn, undefined, [n]);
  return direct + computed;
}
