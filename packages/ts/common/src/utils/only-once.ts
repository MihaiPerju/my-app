/**
 * Creates a wrapper function that ensures the original function is called only
 * once successfully. Subsequent calls after a successful invocation return
 * `undefined` without executing the original function. If the wrapped function
 * throws, the wrapper is not locked — the next call will attempt to invoke it
 * again.
 *
 * @template T - The type of the function to wrap.
 * @param fn - The function to be called only once.
 * @returns A new function with the same signature that can be called multiple
 *          times but will only execute the original function on the first
 *          successful invocation.
 *
 * @example
 * ```ts
 * function doExpensiveOperation(data: unknown) {
 *   // ...
 * }
 *
 * const processOnce = onlyOnce(doExpensiveOperation)
 *
 * processOnce('foo')  // Executes doExpensiveOperation('foo')
 * processOnce('bar')  // Does nothing, and returns undefined
 * ```
 */
export function onlyOnce<Args extends readonly unknown[], Return>(
  fn: (...args: Args) => Return,
): (...args: Args) => Return | undefined {
  let wasCalled = false;
  return (...args) => {
    if (wasCalled) return undefined;
    const result = fn(...args);
    wasCalled = true;
    return result;
  };
}
