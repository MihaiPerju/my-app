import { describe, expect, it } from "vitest";

import { parseCronExpression } from "./cron";

const samples = [
  // Valid – wildcards and basic numeric values
  { case: "every minute", input: "* * * * *", expected: true },
  { case: "daily at midnight", input: "0 0 * * *", expected: true },
  { case: "last minute of day", input: "59 23 * * *", expected: true },
  { case: "specific time", input: "30 9 * * *", expected: true },

  // Valid – steps
  {
    case: "every 5 minutes (wildcard base)",
    input: "*/5 * * * *",
    expected: true,
  },
  { case: "every 2 hours", input: "0 */2 * * *", expected: true },
  { case: "step of 1", input: "*/1 * * * *", expected: true },
  { case: "step with range base", input: "0 9 1-15/3 * *", expected: true },

  // Valid – ranges
  { case: "numeric weekday range", input: "0 8 * * 1-5", expected: true },
  {
    case: "named weekday range (mixed case)",
    input: "0 8 * * Mon-Fri",
    expected: true,
  },
  {
    case: "named weekday range (uppercase)",
    input: "0 8 * * MON-FRI",
    expected: true,
  },
  { case: "named month range", input: "0 9 * Jan-Jun *", expected: true },

  // Valid – lists
  { case: "numeric day-of-week list", input: "0 9 * * 1,3,5", expected: true },
  { case: "day-of-month list", input: "0 9 1,15 * *", expected: true },
  { case: "numeric month list", input: "0 9 * 1,6,12 *", expected: true },
  { case: "named month list", input: "0 9 * Jan,Jun,Dec *", expected: true },
  {
    case: "named day-of-week list",
    input: "0 9 * * Mon,Wed,Fri",
    expected: true,
  },
  {
    case: "list with embedded range",
    input: "0 9 1,3-5,7 * *",
    expected: true,
  },

  // Valid – named single values
  { case: "Sunday by name", input: "0 10 * * Sun", expected: true },
  { case: "Sunday as 7", input: "0 10 * * 7", expected: true },
  { case: "Monday by name", input: "0 10 * * Mon", expected: true },
  { case: "January by name", input: "0 9 * Jan *", expected: true },
  { case: "January uppercase", input: "0 9 * JAN *", expected: true },
  { case: "December by name", input: "0 9 * Dec *", expected: true },
  {
    case: "named month with specific day",
    input: "0 9 1 Jan *",
    expected: true,
  },

  // Invalid – structure
  { case: "too few parts", input: "* * * *", expected: false },
  { case: "too many parts", input: "* * * * * *", expected: false },
  { case: "empty string", input: "", expected: false },
  { case: "leading space", input: " * * * * *", expected: false },
  { case: "trailing space", input: "* * * * * ", expected: false },
  { case: "double space between fields", input: "*  * * * *", expected: false },

  // Invalid – out of range
  { case: "minute 60", input: "60 * * * *", expected: false },
  { case: "hour 24", input: "* 24 * * *", expected: false },
  { case: "dayOfMonth 0", input: "* * 0 * *", expected: false },
  { case: "dayOfMonth 32", input: "* * 32 * *", expected: false },
  { case: "month 0", input: "* * * 0 *", expected: false },
  { case: "month 13", input: "* * * 13 *", expected: false },
  { case: "dayOfWeek 8", input: "* * * * 8", expected: false },

  // Invalid – bad values
  { case: "non-numeric minute", input: "abc * * * *", expected: false },
  { case: "invalid month name", input: "* * * Foo *", expected: false },
  { case: "invalid day-of-week name", input: "* * * * Bar", expected: false },

  // Invalid – bad step
  { case: "step 0", input: "*/0 * * * *", expected: false },
  { case: "negative step", input: "*/-1 * * * *", expected: false },
  { case: "non-numeric step", input: "*/abc * * * *", expected: false },
  { case: "double slash", input: "1//5 * * * *", expected: false },

  // Invalid – bad ranges
  { case: "inverted numeric range", input: "* * * * 6-1", expected: false },
  {
    case: "inverted named range (Sat > Mon)",
    input: "* * * * Sat-Mon",
    expected: false,
  },
  {
    case: "range endpoint out of range",
    input: "* * * * 1-8",
    expected: false,
  },
];

describe(parseCronExpression.name, () => {
  it.each(samples)("$case", ({ input, expected }) => {
    expect(parseCronExpression(input).success).toBe(expected);
  });

  it("parses wildcard fields as { type: 'any' }", () => {
    const result = parseCronExpression("* * * * *");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "any" },
        hour: { type: "any" },
        dayOfMonth: { type: "any" },
        month: { type: "any" },
        dayOfWeek: { type: "any" },
      },
    });
  });

  it("parses numeric values as { type: 'value' }", () => {
    const result = parseCronExpression("30 9 * * *");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "value", value: 30 },
        hour: { type: "value", value: 9 },
        dayOfMonth: { type: "any" },
        month: { type: "any" },
        dayOfWeek: { type: "any" },
      },
    });
  });

  it("parses step with wildcard base as { type: 'step' }", () => {
    const result = parseCronExpression("*/5 * * * *");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "step", base: { type: "any" }, step: 5 },
        hour: { type: "any" },
        dayOfMonth: { type: "any" },
        month: { type: "any" },
        dayOfWeek: { type: "any" },
      },
    });
  });

  it("parses numeric range as { type: 'range' }", () => {
    const result = parseCronExpression("0 8 * * 1-5");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "value", value: 0 },
        hour: { type: "value", value: 8 },
        dayOfMonth: { type: "any" },
        month: { type: "any" },
        dayOfWeek: { type: "range", from: 1, to: 5 },
      },
    });
  });

  it("normalizes named day-of-week range to numeric values", () => {
    const result = parseCronExpression("0 8 * * Mon-Fri");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "value", value: 0 },
        hour: { type: "value", value: 8 },
        dayOfMonth: { type: "any" },
        month: { type: "any" },
        dayOfWeek: { type: "range", from: 1, to: 5 },
      },
    });
  });

  it("normalizes named month to numeric value", () => {
    const result = parseCronExpression("0 9 * Jan *");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "value", value: 0 },
        hour: { type: "value", value: 9 },
        dayOfMonth: { type: "any" },
        month: { type: "value", value: 1 },
        dayOfWeek: { type: "any" },
      },
    });
  });

  it("parses list with embedded range", () => {
    const result = parseCronExpression("0 9 1,3-5,7 * *");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "value", value: 0 },
        hour: { type: "value", value: 9 },
        dayOfMonth: {
          type: "list",
          values: [
            { type: "value", value: 1 },
            { type: "range", from: 3, to: 5 },
            { type: "value", value: 7 },
          ],
        },
        month: { type: "any" },
        dayOfWeek: { type: "any" },
      },
    });
  });

  it("rejects step 0 (*/0) with success: false", () => {
    const result = parseCronExpression("*/0 * * * *");
    expect(result).toEqual({ success: false });
  });

  it("rejects step 0 on a range base (1-5/0) with success: false", () => {
    const result = parseCronExpression("* * 1-5/0 * *");
    expect(result).toEqual({ success: false });
  });

  it("parses step with range base", () => {
    const result = parseCronExpression("0 9 1-15/3 * *");
    expect(result).toEqual({
      success: true,
      data: {
        minute: { type: "value", value: 0 },
        hour: { type: "value", value: 9 },
        dayOfMonth: {
          type: "step",
          base: { type: "range", from: 1, to: 15 },
          step: 3,
        },
        month: { type: "any" },
        dayOfWeek: { type: "any" },
      },
    });
  });
});
