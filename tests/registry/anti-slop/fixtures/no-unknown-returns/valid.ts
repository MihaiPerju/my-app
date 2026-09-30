type Payload = { id: string };

export function fetchOne(): Payload {
  return { id: "a" };
}

export function fetchAsync(): Promise<Payload> {
  return Promise.resolve({ id: "a" });
}

export function scoped(): Payload {
  type Payload = { count: number };
  const inner = (): Payload => ({ count: 1 });
  inner();
  return { id: "b" };
}

export type { Payload };
