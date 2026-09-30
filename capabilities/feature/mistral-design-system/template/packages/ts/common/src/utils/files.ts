import { binaryStringToUint8Array } from "./encoding";

/**
 * Convert a raw base64 string (no data-URL prefix) to a `File` object.
 *
 * @param base64 - The base64-encoded data (without the `data:...;base64,` prefix).
 * @param mimeType - The MIME type of the file (e.g. `"image/png"`).
 * @param name - The file name (e.g. `"image.png"`).
 * @returns A `File` instance with the decoded content.
 * @throws {Error} If `base64` is not valid base64.
 */
export function base64ToFile(
  base64: string,
  mimeType: string,
  name: string,
): File {
  let binaryString: string;
  try {
    binaryString = atob(base64);
  } catch {
    throw new Error(`base64ToFile: invalid base64 string`);
  }
  return new File([binaryStringToUint8Array(binaryString)], name, {
    type: mimeType,
  });
}
