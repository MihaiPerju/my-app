import { describe, expect, it } from "vitest";

import {
  CONFIRMATION_REASON_MAX_LENGTH,
  classifyConfirmationReason,
  parseConfirmationReason,
} from "./confirmation-reason";

describe("parseConfirmationReason", () => {
  it("returns valid with the trimmed text for a non-blank string within the cap", () => {
    expect(
      parseConfirmationReason({
        _confirmationReason: "  Send a Slack reminder every weekday.  ",
      }),
    ).toEqual({
      status: "valid",
      text: "Send a Slack reminder every weekday.",
    });
  });

  it("returns missing when the property is absent", () => {
    expect(parseConfirmationReason({ other: "value" })).toEqual({
      status: "missing",
      text: undefined,
    });
  });

  it("returns missing when the property is null or undefined", () => {
    expect(parseConfirmationReason({ _confirmationReason: null })).toEqual({
      status: "missing",
      text: undefined,
    });
    expect(parseConfirmationReason({ _confirmationReason: undefined })).toEqual(
      {
        status: "missing",
        text: undefined,
      },
    );
  });

  it("returns missing for a non-object input", () => {
    expect(parseConfirmationReason(null)).toEqual({
      status: "missing",
      text: undefined,
    });
    expect(parseConfirmationReason(undefined)).toEqual({
      status: "missing",
      text: undefined,
    });
    expect(parseConfirmationReason("a string")).toEqual({
      status: "missing",
      text: undefined,
    });
    expect(parseConfirmationReason(42)).toEqual({
      status: "missing",
      text: undefined,
    });
    expect(parseConfirmationReason([])).toEqual({
      status: "missing",
      text: undefined,
    });
  });

  it("returns invalid for a blank string", () => {
    expect(parseConfirmationReason({ _confirmationReason: "   " })).toEqual({
      status: "invalid",
      text: undefined,
    });
    expect(parseConfirmationReason({ _confirmationReason: "" })).toEqual({
      status: "invalid",
      text: undefined,
    });
  });

  it("returns invalid for a non-string value", () => {
    expect(parseConfirmationReason({ _confirmationReason: 42 })).toEqual({
      status: "invalid",
      text: undefined,
    });
    expect(parseConfirmationReason({ _confirmationReason: { a: 1 } })).toEqual({
      status: "invalid",
      text: undefined,
    });
    expect(parseConfirmationReason({ _confirmationReason: ["x"] })).toEqual({
      status: "invalid",
      text: undefined,
    });
  });

  it("returns oversized for a non-blank string longer than the cap, with no text", () => {
    expect(
      parseConfirmationReason({
        _confirmationReason: "x".repeat(CONFIRMATION_REASON_MAX_LENGTH + 1),
      }),
    ).toEqual({ status: "oversized", text: undefined });
  });

  it("returns valid at exactly the cap boundary", () => {
    expect(
      parseConfirmationReason({
        _confirmationReason: "x".repeat(CONFIRMATION_REASON_MAX_LENGTH),
      }),
    ).toEqual({
      status: "valid",
      text: "x".repeat(CONFIRMATION_REASON_MAX_LENGTH),
    });
  });
});

describe("classifyConfirmationReason", () => {
  it("derives the status from parseConfirmationReason", () => {
    expect(
      classifyConfirmationReason({ _confirmationReason: "Send a reminder." }),
    ).toBe("valid");
    expect(classifyConfirmationReason({ other: "value" })).toBe("missing");
    expect(classifyConfirmationReason({ _confirmationReason: null })).toBe(
      "missing",
    );
    expect(classifyConfirmationReason(null)).toBe("missing");
    expect(classifyConfirmationReason({ _confirmationReason: "   " })).toBe(
      "invalid",
    );
    expect(classifyConfirmationReason({ _confirmationReason: 42 })).toBe(
      "invalid",
    );
    expect(
      classifyConfirmationReason({
        _confirmationReason: "x".repeat(CONFIRMATION_REASON_MAX_LENGTH + 1),
      }),
    ).toBe("oversized");
  });
});
