import { describe, expect, it, vi } from "vitest";

import { stopEvent } from "./events";
import type { StoppableEvent } from "./types";

describe("stopEvent", () => {
  it("fully stops the keyboard event propagation", () => {
    const mockEvent: StoppableEvent = {
      stopPropagation: vi.fn(),
      preventDefault: vi.fn(),
      stopImmediatePropagation: vi.fn(),
    };

    stopEvent(mockEvent);

    for (const eventHandlerSpy of Object.values(mockEvent)) {
      expect(eventHandlerSpy).toHaveBeenCalledOnce();
    }
  });
});
