import { describe, expect, it } from "vitest";

import { getModelDisplayName } from "./model-display-name";

describe("getModelDisplayName", () => {
  it("uses exact display names when available", () => {
    expect(getModelDisplayName("mistral-medium-3-5")).toBe(
      "Mistral Medium 3.5",
    );
    expect(getModelDisplayName("mistral-medium-2508")).toBe(
      "Mistral Medium 3.1",
    );
    expect(getModelDisplayName("mistral-medium-2505")).toBe("Mistral Medium 3");
  });

  it("formats Mistral model families by prefix", () => {
    expect(getModelDisplayName("mistral-medium-latest")).toBe("Mistral Medium");
    expect(getModelDisplayName("mistral-small-latest")).toBe("Mistral Small");
    expect(getModelDisplayName("mistral-large-latest")).toBe("Mistral Large");
  });

  it("falls back to the raw model name", () => {
    expect(getModelDisplayName("custom-model")).toBe("custom-model");
  });
});
