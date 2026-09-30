// `btoa` takes a binary string, and spreading a whole recording into String.fromCharCode
// would blow the argument limit, so the bytes are folded in blocks.
const BASE64_BLOCK_SIZE = 0x8000;

/** Base64 for `file_content`, which the API wants bare — no `data:<mime>;base64,` prefix. */
export async function blobToBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_BLOCK_SIZE) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_BLOCK_SIZE));
  }
  return btoa(binary);
}

/** The extension the transcribe mount infers the container from, per recorder MIME type. */
export function fileNameFor(mimeType: string | undefined): string {
  if (mimeType?.startsWith("audio/mp4")) return "recording.mp4";
  if (mimeType?.startsWith("audio/ogg")) return "recording.ogg";
  return "recording.webm";
}
