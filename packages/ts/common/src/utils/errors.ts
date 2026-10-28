/**
 * Extracts a readable error message from an unknown error value.
 *
 * @param error - The error value to extract a message from (typically from a catch block).
 * @returns A string error message, or "Unknown error" if no message can be determined.
 *
 * @example
 * ```ts
 * try {
 *   // Some code
 * } catch (error) {
 *   const message = getErrorMessage(error);
 *   console.error(message);
 * }
 * ```
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  // Check if it's an object with a message property
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  try {
    const stringified = JSON.stringify(error);
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- `JSON.stringify` can return undefined for some values (functions, symbols, undefined) even though TypeScript types it as string, so we need to a runtime check
    if (stringified !== undefined && stringified !== "{}") {
      return stringified;
    }
  } catch {
    // JSON.stringify failed (e.g., circular reference)
  }

  try {
    return String(error);
  } catch {
    return "Unknown error";
  }
}

/**
 * Converts an unknown value to an `Error` object.
 *
 * If the value is already an `Error`, it is returned as-is. Otherwise, it creates
 * a new `Error` with a message extracted from the value using {@link getErrorMessage}.
 *
 * Useful for normalizing error handling when you need to ensure you're always
 * working with `Error` objects, regardless of what was thrown or passed.
 *
 * @param error - The error value to convert (typically from a catch block).
 * @returns An `Error` object.
 *
 * @example
 * ```ts
 * try {
 *   // Some code that might throw
 * } catch (error) {
 *   const normalizedError = toError(error);
 *   // Now guaranteed to be an `Error` object
 *   console.error(normalizedError.stack);
 * }
 * ```
 *
 * @example
 * ```ts
 * // Handle different error types
 * function handleError(error: unknown) {
 *   const err = toError(error);
 *   if (err instanceof TypeError) {
 *     // Handle type errors
 *   } else {
 *     // Handle other errors
 *   }
 * }
 * ```
 */
export function toError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }

  return new Error(getErrorMessage(error));
}
