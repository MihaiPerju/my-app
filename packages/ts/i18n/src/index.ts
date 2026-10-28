import deepmerge from "deepmerge";

export const LOCALES = [
  "en",
  "fr",
  "de",
  "es",
  "pl",
  "it",
  "pt-BR",
  "ar",
  "nl",
  "uk",
  "ko",
] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE = "en";

export const isLocale = (locale: string): locale is Locale =>
  LOCALES.includes(locale as Locale);

export const LANG_COOKIE_NAME = "lang";

export function getSupportedLocale(locale?: string | null): Locale {
  if (!locale) {
    return DEFAULT_LOCALE;
  }

  if (isLocale(locale)) {
    return locale;
  }

  const languageCode = locale.split("-")[0];
  if (languageCode && isLocale(languageCode)) {
    return languageCode;
  }

  // "pt" is not in LOCALES — only "pt-BR" is. Map any Portuguese variant to Brazilian Portuguese.
  if (languageCode === "pt") return "pt-BR";

  return DEFAULT_LOCALE;
}

export const getMobileSupportedLocale = (
  locale: string | null | undefined,
): Locale => {
  if (!locale) {
    return DEFAULT_LOCALE;
  }

  // We display the Brazilian Portuguese version of the app for Portuguese users - better than english
  if (locale === "pt") {
    return "pt-BR";
  }

  // Arabic is supported in Le Chat Web but we don't fully support RTL in the app
  if (locale === "ar") {
    return DEFAULT_LOCALE;
  }

  return isLocale(locale) ? locale : DEFAULT_LOCALE;
};

/**
 * Recursive Partial<T> type helper.
 */
export type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export function getDirection(locale: string): "ltr" | "rtl" {
  return locale === "ar" ? "rtl" : "ltr";
}

export function createMergeWithDefaultTranslations<T extends object>(
  defaultMessages: T,
  localeWithMessages: { en: T } & Record<Locale, DeepPartial<T>>,
) {
  return (locale: Locale): T => {
    const localeMessages = localeWithMessages[locale];
    const messages = deepmerge(
      defaultMessages as Partial<T>,
      localeMessages as Partial<T>,
      {
        arrayMerge: (target, source, options) => {
          const destination = target.slice();

          source.forEach((item, index) => {
            destination[index] =
              options?.cloneUnlessOtherwiseSpecified(item, options) ?? item;
          });

          return destination;
        },
      },
    );
    return messages;
  };
}

export function createGetTranslations<T>(
  mergeWithDefaultTranslations: (locale: Locale) => T,
) {
  return ({ locale }: { locale: Locale }): T => {
    return mergeWithDefaultTranslations(locale);
  };
}
