// The app's only date formatting, ported from le-chat's `formatMessageDate`. It uses `Intl`, not
// a date library, because the two shapes below are the whole requirement. A second date format
// belongs here rather than in a new ad-hoc `toLocaleString` call site.

export type MessageDateFormat = "relative" | "long";

export type FormatMessageDateOptions = {
  /** Left undefined on purpose: `Intl` then uses the runtime's own locale. */
  locale?: string;
  format?: MessageDateFormat;
  /** The instant "today" and "yesterday" are measured against. Overridable so tests can freeze it. */
  now?: Date;
};

const YESTERDAY = "Yesterday";

/**
 * Formats a message timestamp for display beside a chat bubble: `"2:15pm"` today, `"Yesterday
 * 2:15pm"` yesterday, and `"Apr 20, 9:00am"` when older or `format: "long"`. Returns `""` for a
 * non-date value, so a caller renders nothing rather than `"Invalid Date"`.
 */
export function formatMessageDate(
  value: Date | string | number,
  { locale, format = "relative", now = new Date() }: FormatMessageDateOptions = {},
): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";

  const time = formatTime(date, locale);
  const full = `${dateFormatter(locale).format(date)}, ${time}`;
  if (format === "long") return full;

  const day = startOfDay(date).getTime();
  const today = startOfDay(now);
  if (day === today.getTime()) return time;

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (day === yesterday.getTime()) return `${YESTERDAY} ${time}`;

  return full;
}

function timeFormatter(locale: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { hour: "numeric", minute: "2-digit" });
}

function dateFormatter(locale: string | undefined): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric" });
}

// "2:15 PM" -> "2:15pm". A locale with no meridiem is left exactly as the formatter wrote it.
function formatTime(date: Date, locale: string | undefined): string {
  return timeFormatter(locale)
    .format(date)
    .replace(/\s?(AM|PM)/i, (meridiem) => meridiem.trim().toLowerCase());
}

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}
