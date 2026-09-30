import { z } from "zod";

// With `throwOnError: true` the generated client rejects with the raw parsed response body (for
// example FastAPI's `{ detail: ... }`), which is not an `Error`, so UI that reads `err.message`
// renders nothing. The rejection is parsed here, at the client boundary, into a message.
const rejection = z.union([
  z.object({ detail: z.string() }).transform(({ detail }) => detail),
  z.object({ detail: z.unknown() }).transform(({ detail }) => JSON.stringify(detail)),
  z.string(),
  z.unknown().transform((value) => JSON.stringify(value)),
]);

/** Unwraps a hey-api SDK result: the typed data, or a real `Error` carrying the server's message. */
export async function unwrap<T>(promise: Promise<{ data: T }>): Promise<T> {
  try {
    return (await promise).data;
  } catch (error) {
    if (error instanceof Error) throw error;
    throw new Error(rejection.parse(error), { cause: error });
  }
}
