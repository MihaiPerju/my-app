/**
 * A no-op function that does nothing.
 *
 * Useful as a default callback, placeholder function, or when you need
 * to explicitly indicate that a function parameter should do nothing.
 *
 * @example
 * ```ts
 * function processData(data: unknown, onComplete = noop) {
 *   onComplete();
 * }
 * ```
 *
 * @example
 * ```ts
 * // Use as a placeholder
 * const unsubscribe = noop; // Will be replaced with actual function later
 * ```
 */
export function noop(): void {
  // Intentionally empty
}
