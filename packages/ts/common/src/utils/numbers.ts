/**
 * Checks if a number is an integer.
 *
 * @param number the number to check.
 * @returns true if the number is an integer, false otherwise.
 */
export function isInteger(number: number): boolean {
  return Number.isInteger(number);
}

/**
 * Checks if a number is even.
 *
 * @param number the number to check.
 * @returns true if the number is even, false otherwise.
 */
export function isEven(number: number): boolean {
  if (!isInteger(number)) {
    throw new Error("Number is not an integer");
  }
  return number % 2 === 0;
}

/**
 * Checks if a number is odd.
 *
 * @param number the number to check.
 * @returns true if the number is odd, false otherwise.
 */
export function isOdd(number: number): boolean {
  if (!isInteger(number)) {
    throw new Error("Number is not an integer");
  }
  return number % 2 !== 0;
}
