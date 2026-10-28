/**
 * Executes a function and retries based on a custom condition.
 *
 * This utility is useful for operations that might occasionally return undesired results
 * due to temporary conditions, where you want to retry based on the actual result value
 * rather than treating it as an error.
 *
 * @template T - The type of value returned by the function.
 * @param fn - The async function to execute that returns a Promise of type T.
 * @param shouldRetry - A predicate function that determines if a retry should occur based on the result.
 * @param options - Configuration options for retry behavior.
 * @param options.maxRetries - Number of retry attempts after the first call (defaults to 3).
 *   Total invocations = `maxRetries + 1`: the initial call plus up to `maxRetries` retries.
 * @param options.delayMs - Delay between retries in milliseconds (defaults to 500).
 * @returns A promise that resolves to the result returned by the function.
 *
 * @example
 * ```ts
 * // Retry on empty arrays
 * const result = await withRetryOnCondition(
 *   () => fetchArray(),
 *   (arr) => arr.length === 0,
 *   { maxRetries: 5, delayMs: 500 }
 * );
 * ```
 *
 * @example
 * ```ts
 * // Retry on empty objects
 * const data = await withRetryOnCondition(
 *   () => fetchData(),
 *   (obj) => Object.keys(obj).length === 0
 * );
 * ```
 */
export async function withRetryOnCondition<T>(
  fn: () => Promise<T>,
  shouldRetry: (result: T) => boolean,
  options: {
    maxRetries?: number;
    delayMs?: number;
  } = {},
): Promise<T> {
  const { maxRetries = 3, delayMs = 500 } = options;

  for (let i = 0; i < maxRetries; i++) {
    const result = await fn();

    if (!shouldRetry(result)) {
      return result;
    }

    if (i < maxRetries - 1) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }

  // If we reach this point, it means all retries failed
  // We call the function one more time and return whatever it gives us
  return fn();
}
