import { z } from "zod";

export const localizedVibeAppNameSchema = z
  .object({
    en: z.string().min(1),
  })
  .and(z.record(z.string(), z.string().min(1)));

export type LocalizedVibeAppName = z.infer<typeof localizedVibeAppNameSchema>;

export const createLocalizedVibeAppNameEnvSchema = (
  defaultAppName: LocalizedVibeAppName,
) =>
  z
    .string()
    .default(JSON.stringify(defaultAppName))
    .transform((value, ctx): unknown => {
      try {
        return JSON.parse(value);
      } catch {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: "Expected a JSON object with at least a non-empty en value",
        });
        return z.NEVER;
      }
    })
    .pipe(localizedVibeAppNameSchema);

const getLocaleCandidates = (locale?: string): string[] => {
  if (!locale) return ["en"];

  const normalizedLocale = locale.replaceAll("_", "-");
  const canonicalLocale = (() => {
    try {
      return new Intl.Locale(normalizedLocale).toString();
    } catch {
      return normalizedLocale;
    }
  })();
  const [language = canonicalLocale] = canonicalLocale.split("-");

  return [canonicalLocale, language, "en"];
};

export const resolveLocalizedVibeAppName = (
  appName: LocalizedVibeAppName,
  locale?: string,
): string => {
  for (const candidate of getLocaleCandidates(locale)) {
    const value = appName[candidate];

    if (value) return value;
  }

  return appName.en;
};
