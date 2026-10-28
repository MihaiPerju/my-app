const cache = new Map<string, RegExp>();

/**
 * Safely tests a value against a regex pattern without throwing errors.
 * The compiled `RegExp` is cached by pattern and flags to avoid repeated allocations.
 *
 * @param pattern - The regex pattern string to test against.
 * @param value - The value to test.
 * @param flags - Optional regex flags (e.g. `"i"`, `"g"`). Defaults to no flags.
 * @returns `true` if the value matches, `false` if it doesn't match,
 *          or `null` if the pattern is invalid.
 */
export function safeRegexTest(
  pattern: string,
  value: string,
  flags?: string,
): boolean | null {
  const key = `${flags ?? ""}:${pattern}`;
  let re = cache.get(key);
  if (!re) {
    try {
      re = new RegExp(pattern, flags);
    } catch {
      return null;
    }
    cache.set(key, re);
  }
  // `g` and `y` flags mutate lastIndex on the shared cached instance; reset it
  // so each call has the same "does this value match" semantics as a fresh RegExp.
  re.lastIndex = 0;
  return re.test(value);
}
