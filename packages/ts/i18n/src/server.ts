import { match } from "@formatjs/intl-localematcher";
import Negotiator from "negotiator";

import type { Locale } from ".";
import { DEFAULT_LOCALE, isLocale, LANG_COOKIE_NAME, LOCALES } from ".";

// Diverges from upstream: replaces `import logger from "@mistral/monitoring/logger"`,
// an unpublished `workspace:*` package that cannot be vendored. The one call site
// below is the only use, so the pino-style signature is inlined instead.
const logger = {
  warn: (bindings: Record<string, unknown>, message: string): void => {
    console.warn(message, bindings);
  },
};

export const getLocaleFromRequest = ({
  headers,
  cookies,
}: {
  headers: Headers;
  cookies: Pick<Map<string, { value: string }>, "get">;
}) => {
  const languages = new Negotiator({
    headers: {
      "accept-language": headers.get("accept-language") as string | undefined,
    },
  }).languages();

  const userPreferredLang = cookies.get(LANG_COOKIE_NAME)?.value;

  let locale: Locale = DEFAULT_LOCALE;
  if (userPreferredLang && isLocale(userPreferredLang)) {
    locale = userPreferredLang;
  } else {
    try {
      const matchedLocale = match(languages, LOCALES, DEFAULT_LOCALE);
      if (isLocale(matchedLocale)) {
        locale = matchedLocale;
      } else {
        throw new Error("Locale not found");
      }
    } catch (_error) {
      logger.warn(
        {
          languages,
          locales: LOCALES,
          defaultLocale: DEFAULT_LOCALE,
        },
        "Error during locale matching",
      );
    }
  }

  return locale;
};
