export function read(target: { id: string }): string {
  return target.id;
}

export function probe(target: { id: string }): boolean {
  return Reflect.has(target, "id");
}

export function shadowed(): string {
  const Reflect = { get: (key: string): string => key };
  return Reflect.get("id");
}
