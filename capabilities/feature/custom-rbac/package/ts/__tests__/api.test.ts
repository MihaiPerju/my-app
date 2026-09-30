import { describe, expect, test } from "bun:test";

import { ACT_AS_HEADER, AccessApiError, createAccessClient, errorMessage } from "../src/api";

describe("errorMessage", () => {
  test("reads a FastAPI string detail", () => {
    expect(errorMessage('{"detail":"A team named \'x\' already exists."}')).toBe(
      "A team named 'x' already exists.",
    );
  });

  test("joins a validation error list", () => {
    const body = JSON.stringify({ detail: [{ msg: "field required" }, { msg: "not an email" }] });
    expect(errorMessage(body)).toBe("field required; not an email");
  });

  test("falls back to the raw body", () => {
    expect(errorMessage("Bad Gateway")).toBe("Bad Gateway");
    expect(errorMessage('{"other":1}')).toBe('{"other":1}');
  });
});

describe("createAccessClient", () => {
  test("surfaces the server's detail on failure and sends act-as", async () => {
    const seen: Headers[] = [];
    const client = createAccessClient({
      actAs: () => "target@x.io",
      fetch: (async (_url: string, init: RequestInit) => {
        seen.push(new Headers(init.headers));
        return new Response('{"detail":"You cannot demote yourself."}', { status: 409 });
      }) as typeof fetch,
    });
    const error = await client.setUserAdmin(1, false).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AccessApiError);
    expect((error as AccessApiError).status).toBe(409);
    expect((error as AccessApiError).message).toBe("You cannot demote yourself.");
    expect(seen[0]?.get(ACT_AS_HEADER)).toBe("target@x.io");
  });
});
