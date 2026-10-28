import { describe, expect, test } from "bun:test";

import { formatMessageDate } from "@mistralai-capabilities/feature-mistral-design-system/lib";

// "now" is passed in rather than mocked: the boundary between today, yesterday and older is
// the whole behaviour, and a suite that read the real clock would change meaning at midnight.
const NOW = new Date(2025, 3, 23, 18, 30);

// Local time, not an ISO string with a Z: the formatter compares calendar days in the
// runtime's own zone, so a UTC literal would land on a different day depending on the runner.
function at(year: number, month: number, day: number, hour: number, minute: number): Date {
  return new Date(year, month, day, hour, minute);
}

describe("formatMessageDate", () => {
  test("shows only the time for today", () => {
    expect(formatMessageDate(at(2025, 3, 23, 14, 15), { locale: "en-US", now: NOW })).toBe(
      "2:15pm",
    );
  });

  test("names yesterday and keeps the time", () => {
    expect(formatMessageDate(at(2025, 3, 22, 14, 15), { locale: "en-US", now: NOW })).toBe(
      "Yesterday 2:15pm",
    );
  });

  test("spells the date out for anything older", () => {
    expect(formatMessageDate(at(2025, 3, 20, 9, 0), { locale: "en-US", now: NOW })).toBe(
      "Apr 20, 9:00am",
    );
  });

  // The tooltip form: unambiguous whatever the reader is looking at, so it must not collapse
  // to a bare time just because the message happens to be from today.
  test("long always spells the date out, today included", () => {
    expect(
      formatMessageDate(at(2025, 3, 23, 14, 15), { locale: "en-US", format: "long", now: NOW }),
    ).toBe("Apr 23, 2:15pm");
  });

  test("lowercases the meridiem and drops the space before it", () => {
    const formatted = formatMessageDate(at(2025, 3, 23, 9, 5), { locale: "en-US", now: NOW });
    expect(formatted).toBe("9:05am");
  });

  // `createdAt` is a string off the wire, so a malformed one must render as nothing rather
  // than putting "Invalid Date" beside a chat bubble.
  test("returns an empty string for a value that is not a date", () => {
    expect(formatMessageDate("not a date", { locale: "en-US", now: NOW })).toBe("");
  });
});
