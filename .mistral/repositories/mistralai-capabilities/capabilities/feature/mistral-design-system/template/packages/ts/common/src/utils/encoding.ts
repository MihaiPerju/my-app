/**
 * Converts a binary string (as returned by `atob`) to a `Uint8Array`.
 *
 * @param binary - A binary string where each character's code unit is a byte value (0-255).
 * @returns A `Uint8Array` containing the corresponding byte values.
 */
export function binaryStringToUint8Array(
  binary: string,
): Uint8Array<ArrayBuffer> {
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
