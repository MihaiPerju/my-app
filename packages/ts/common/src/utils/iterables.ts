type AsyncIterableLike = {
  [Symbol.asyncIterator]?: unknown;
};

/**
 * Returns true when the value exposes an async iterator.
 */
export function isAsyncIterable<T = unknown>(
  value: unknown,
): value is AsyncIterable<T> {
  if (
    (typeof value !== "object" && typeof value !== "function") ||
    value === null
  ) {
    return false;
  }

  return (
    typeof (value as AsyncIterableLike)[Symbol.asyncIterator] === "function"
  );
}
