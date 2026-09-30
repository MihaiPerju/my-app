import { describe, expect, it } from "vitest";

import {
  createMergeWithDefaultTranslations,
  type DeepPartial,
  getSupportedLocale,
  type Locale,
  LOCALES,
} from "./index";

describe("getSupportedLocale", () => {
  it.each([undefined, null, ""])("returns default for %j", (input) => {
    expect(getSupportedLocale(input)).toBe("en");
  });

  const sameLocales = LOCALES.map((l) => [l, l]);
  it.each(sameLocales)("returns %s for exact match %s", (input, expected) => {
    expect(getSupportedLocale(input)).toBe(expected);
  });

  it.each([
    ["en-US", "en"],
    ["en-GB", "en"],
    ["fr-CA", "fr"],
    ["fr-FR", "fr"],
    ["de-AT", "de"],
    ["es-MX", "es"],
    ["it-CH", "it"],
    ["nl-BE", "nl"],
    ["pl-PL", "pl"],
    ["ar-SA", "ar"],
    ["uk-UA", "uk"],
    ["ko-KR", "ko"],
  ] as const)("extracts language code from %s → %s", (input, expected) => {
    expect(getSupportedLocale(input)).toBe(expected);
  });

  it("maps Portuguese variants to pt-BR", () => {
    expect(getSupportedLocale("pt")).toBe("pt-BR");
    expect(getSupportedLocale("pt-PT")).toBe("pt-BR");
    expect(getSupportedLocale("pt-AO")).toBe("pt-BR");
  });

  it("returns default for unsupported languages", () => {
    expect(getSupportedLocale("ja")).toBe("en");
    expect(getSupportedLocale("zh-CN")).toBe("en");
    expect(getSupportedLocale("sv")).toBe("en");
    expect(getSupportedLocale("xyz")).toBe("en");
  });
});

describe("createMergeWithDefaultTranslations", () => {
  it("uses locale array entries before default entries", () => {
    const defaultMessages = {
      prompts: ["a_en", "b_en", "c_en"],
    };
    const frMessages = {
      prompts: ["a_fr", "b_fr"],
    };

    const mergeWithDefaultTranslations = createMergeWithDefaultTranslations(
      defaultMessages,
      makeLocaleWithMessages(defaultMessages, { fr: frMessages }),
    );

    expect(mergeWithDefaultTranslations("fr").prompts).toEqual([
      "a_fr",
      "b_fr",
      "c_en",
    ]);
  });

  it("keeps default array entries when locale entries are missing", () => {
    const defaultMessages = {
      prompts: ["a_en", "b_en"],
    };

    const mergeWithDefaultTranslations = createMergeWithDefaultTranslations(
      defaultMessages,
      makeLocaleWithMessages(defaultMessages, { fr: {} }),
    );

    expect(mergeWithDefaultTranslations("fr").prompts).toEqual([
      "a_en",
      "b_en",
    ]);
  });
});

type ExcludeEnLocale = Exclude<Locale, "en">;

function makeLocaleWithMessages<T extends object>(
  defaultMessages: T,
  overrides: Partial<Record<ExcludeEnLocale, DeepPartial<T>>> = {},
): { en: T } & Record<ExcludeEnLocale, DeepPartial<T>> {
  const empty = {} as DeepPartial<T>;
  return {
    en: defaultMessages,
    fr: empty,
    de: empty,
    es: empty,
    pl: empty,
    it: empty,
    "pt-BR": empty,
    ar: empty,
    nl: empty,
    uk: empty,
    ko: empty,
    ...overrides,
  };
}
