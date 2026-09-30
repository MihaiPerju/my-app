/**
 * Score multiplier applied per character when a query matches its text exactly.
 * Intentionally large to ensure exact matches rank above any partial match.
 */
export const EXACT_MATCH_SCORE = 99;

/**
 * Scores a fuzzy subsequence match of a query against a text string.
 * All characters in the query must appear in order in the text, but
 * not necessarily contiguously.
 *
 * Returns a score (higher is better) or `null` if there is no match.
 *
 * @example
 * fuzzyMatch("cdin", "Code Interpreter") // 7
 * fuzzyMatch("xyz", "Code Interpreter")  // null
 */
export function fuzzyMatch(
  query: string,
  text: string,
  options: { caseSensitive: boolean } = { caseSensitive: false },
) {
  const normalizedQuery = options.caseSensitive ? query : query.toLowerCase();
  const normalizedText = options.caseSensitive ? text : text.toLowerCase();

  let queryIndex = 0;
  let score = 0;
  let prevMatchIndex = -2;

  // Exact match gets a score far above any subsequence match.
  if (normalizedQuery === normalizedText) {
    return normalizedText.length * EXACT_MATCH_SCORE;
  }

  for (
    let index = 0;
    index < normalizedText.length && queryIndex < normalizedQuery.length;
    index++
  ) {
    if (normalizedText[index] === normalizedQuery[queryIndex]) {
      if (index === prevMatchIndex + 1) {
        score += 2;
      }
      score += 1;
      prevMatchIndex = index;
      queryIndex++;
    }
  }

  if (queryIndex < normalizedQuery.length) {
    return null;
  }

  return score;
}

/**
 * Filters and sorts items by fuzzy matching a query.
 * Returns matched items sorted by score (best first).
 *
 * @example
 * // With array of strings
 * fuzzySearch(["spaghetti", "pasta", "rice"], "spa")
 * // → ["spaghetti"]
 *
 * // With array of objects — pass the key to match on as the second argument
 * fuzzySearch([{ id: 123, name: "spaghetti" }, { id: 321, name: "rice" }], "name", "spa")
 * // → [{ id: 123, name: "spaghetti" }]
 */
export function fuzzySearch(
  items: string[],
  query: string,
  options?: { caseSensitive: boolean },
): string[];
export function fuzzySearch<T>(
  items: T[],
  key: keyof T,
  query: string,
  options?: { caseSensitive: boolean },
): T[];
export function fuzzySearch<T>(
  items: string[] | T[],
  keyOrQuery: keyof T | string,
  queryOrOptions?: string | { caseSensitive: boolean },
  options?: { caseSensitive: boolean },
) {
  const isObjectArray = typeof queryOrOptions === "string";
  const query = isObjectArray ? queryOrOptions : (keyOrQuery as string);
  const key = isObjectArray ? (keyOrQuery as keyof T) : undefined;
  const opts = (isObjectArray
    ? options
    : (queryOrOptions as { caseSensitive: boolean } | undefined)) ?? {
    caseSensitive: false,
  };

  if (!query) return items as (T | string)[];

  const scored: { item: T | string; score: number }[] = [];

  for (const item of items) {
    const text =
      key !== undefined ? String((item as T)[key] ?? "") : String(item);

    const score = fuzzyMatch(query, text, opts);
    if (score !== null) {
      scored.push({ item, score });
    }
  }

  scored.sort((a, b) => b.score - a.score);

  return scored.map((s) => s.item);
}
