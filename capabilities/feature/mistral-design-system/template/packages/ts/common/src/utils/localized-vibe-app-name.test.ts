import { describe, expect, it } from "vitest";

import {
  createLocalizedVibeAppNameEnvSchema,
  resolveLocalizedVibeAppName,
} from "./localized-vibe-app-name";

describe("createLocalizedVibeAppNameEnvSchema", () => {
  it("defaults to the provided English app name", () => {
    const schema = createLocalizedVibeAppNameEnvSchema({ en: "Default Chat" });

    expect(schema.parse(undefined)).toEqual({
      en: "Default Chat",
    });
  });

  it("parses localized app names", () => {
    const schema = createLocalizedVibeAppNameEnvSchema({ en: "Default Chat" });

    expect(
      schema.parse(
        JSON.stringify({ en: "Mistral Chat", fr: "Messagerie Mistral" }),
      ),
    ).toEqual({
      en: "Mistral Chat",
      fr: "Messagerie Mistral",
    });
  });

  it("rejects invalid JSON and values without an English fallback", () => {
    const schema = createLocalizedVibeAppNameEnvSchema({ en: "Default Chat" });

    expect(() => schema.parse("Mistral Chat")).toThrow();
    expect(() => schema.parse(JSON.stringify({ fr: "Messagerie" }))).toThrow();
  });
});

describe("resolveLocalizedVibeAppName", () => {
  it("resolves exact, normalized, language, and English fallback names", () => {
    const appName = {
      en: "Mistral Chat",
      de: "Mistral Chat DE",
      "pt-BR": "Mistral Chat BR",
    };

    expect(resolveLocalizedVibeAppName(appName, "pt-br")).toBe(
      "Mistral Chat BR",
    );
    expect(resolveLocalizedVibeAppName(appName, "de-DE")).toBe(
      "Mistral Chat DE",
    );
    expect(resolveLocalizedVibeAppName(appName, "es")).toBe("Mistral Chat");
  });
});
