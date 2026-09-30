import { describe, expect, test } from "bun:test";

import { disclosureReducer } from "./presence";

describe("disclosureReducer", () => {
  test("opens from every phase", () => {
    expect(disclosureReducer("pristine", "open")).toBe("present");
    expect(disclosureReducer("present", "open")).toBe("present");
    expect(disclosureReducer("exiting", "open")).toBe("present");
    expect(disclosureReducer("settled", "open")).toBe("present");
  });

  test("closes an open panel into the exit animation", () => {
    expect(disclosureReducer("present", "close")).toBe("exiting");
  });

  test("settles only once the exit animation ends", () => {
    expect(disclosureReducer("exiting", "exitEnd")).toBe("settled");
  });

  test("closes instantly when nothing animates", () => {
    expect(disclosureReducer("present", "closeInstant")).toBe("settled");
  });

  test("ignores close events that don't apply", () => {
    // Never-opened panels stay pristine (render no DOM).
    expect(disclosureReducer("pristine", "close")).toBe("pristine");
    // A second close mid-exit is a no-op.
    expect(disclosureReducer("exiting", "close")).toBe("exiting");
    expect(disclosureReducer("settled", "close")).toBe("settled");
  });

  test("ignores a stray exitEnd outside the exit animation", () => {
    // e.g. reopened before the collapse finished — the pending transitionend
    // must not tear the now-visible content back down.
    expect(disclosureReducer("present", "exitEnd")).toBe("present");
    expect(disclosureReducer("pristine", "exitEnd")).toBe("pristine");
    expect(disclosureReducer("settled", "exitEnd")).toBe("settled");
  });

  test("runs the full open → close → settle lifecycle", () => {
    let phase = disclosureReducer("pristine", "open");
    expect(phase).toBe("present");
    phase = disclosureReducer(phase, "close");
    expect(phase).toBe("exiting");
    phase = disclosureReducer(phase, "exitEnd");
    expect(phase).toBe("settled");
    phase = disclosureReducer(phase, "open");
    expect(phase).toBe("present");
  });

  test("keeps content mounted when a close is interrupted by a reopen", () => {
    const exiting = disclosureReducer("present", "close");
    const reopened = disclosureReducer(exiting, "open");
    expect(reopened).toBe("present");
    // A late transitionend from the aborted close is now a no-op.
    expect(disclosureReducer(reopened, "exitEnd")).toBe("present");
  });
});
