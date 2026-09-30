import { describe, expect, test } from "bun:test";

import { unwrap } from "./unwrap";

describe("unwrap", () => {
  test("returns generated-client data", async () => {
    await expect(unwrap(Promise.resolve({ data: { id: "result-1" } }))).resolves.toEqual({
      id: "result-1",
    });
  });

  test("normalizes FastAPI detail responses into Error instances", async () => {
    try {
      await unwrap(Promise.reject({ detail: "Workflow failed" }));
      throw new Error("Expected unwrap to reject");
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      // SAFETY: the expect above fails the test unless `error` is an Error instance.
      expect((error as Error).message).toBe("Workflow failed");
    }
  });
});
