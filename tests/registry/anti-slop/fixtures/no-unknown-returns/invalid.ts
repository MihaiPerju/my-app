export function readTop(source: string): unknown {
  return source;
}

export function readAsync(source: string): Promise<unknown> {
  return source;
}

type Handler = () => unknown;

type Identity<T> = T;

export function readAlias(source: string): Identity<unknown> {
  return source;
}

export type { Handler };
