export function read(target: { id: string }): string {
  const direct = Reflect.get(target, "id");
  const computed = Reflect["get"](target, "id");
  return `${direct}${computed}`;
}
