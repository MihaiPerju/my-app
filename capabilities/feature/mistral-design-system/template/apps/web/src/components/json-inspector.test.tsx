import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test } from "bun:test";

import { JsonInspector } from "@mistralai-capabilities/feature-mistral-design-system/components";

afterEach(cleanup);

describe("JsonInspector", () => {
  test("formats JSON only after the inspector is expanded", () => {
    render(<JsonInspector label="Raw response" value={{ status: "ready" }} />);

    const trigger = screen.getByRole("button", { name: "Raw response" });
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(screen.queryByText(/"status": "ready"/)).toBeNull();

    fireEvent.click(trigger);

    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText(/"status": "ready"/)).toBeTruthy();
  });
});
