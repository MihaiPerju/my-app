import { afterEach, describe, expect, it, vi } from "vitest";

import type { Hotkey } from "./types";
import { isHotkeyMatchingKeyboardEvent } from "./validator";

const mockCurrentlyPressedKeys = new Set<string>();

/**
 * Creates a mock `KeyboardEvent` object with the given key code and optional modifier keys.
 *
 * @internal
 * @param key - The `KeyboardEvent.key` value (e.g., "A", "ArrowUp").
 * @param modifiers - Optional modifier key states (e.g., `altKey`, `ctrlKey`, `metaKey`, `shiftKey`). Defaults to no modifiers.
 * @param type - The type of event (e.g., "keydown", "keyup", "keypress"). Defaults to "keydown".
 * @returns A partial `KeyboardEvent` object suitable for testing.
 */
function createKeyboardEvent(
  key: KeyboardEvent["key"],
  modifiers: Partial<KeyboardEvent> = {},
  type: "keydown" | "keyup" | "keypress" = "keydown",
): KeyboardEvent {
  const event = new KeyboardEvent(type, {
    key,
    altKey: modifiers.altKey ?? false,
    code: modifiers.code ?? "",
    ctrlKey: modifiers.ctrlKey ?? false,
    metaKey: modifiers.metaKey ?? false,
    shiftKey: modifiers.shiftKey ?? false,
  });

  if (modifiers.keyCode !== undefined) {
    Object.defineProperty(event, "keyCode", { value: modifiers.keyCode });
  }

  return event;
}

/**
 * Simulates pressing one or more keys by adding them to the mock `currentlyPressedKeys` Set.
 * Use it to test combinations of key presses that are held simultaneously.
 *
 * @internal
 * @param keys - One or more key strings (already mapped/lowercased) to add as "pressed".
 */
function pressKeys(...keys: string[]): void {
  for (const key of keys) {
    mockCurrentlyPressedKeys.add(key);
  }
}

vi.mock("./state", async () => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports
  const actual = await vi.importActual<typeof import("./state")>("./state");
  return {
    ...actual,
    isHotkeyPressed: (hotkeys: readonly string[]) =>
      hotkeys.every((key) => mockCurrentlyPressedKeys.has(key)),
  };
});

describe("isHotkeyMatchingKeyboardEvent", () => {
  afterEach(() => {
    mockCurrentlyPressedKeys.clear();
  });

  it("returns true for simple key match", () => {
    const event = createKeyboardEvent("A");
    const hotkey: Hotkey = { keys: ["a"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("returns true when modifier alt is correctly pressed", () => {
    const event = createKeyboardEvent("Alt", { altKey: true });
    const hotkey: Hotkey = { alt: true };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("returns false when modifier alt is not pressed", () => {
    const event = createKeyboardEvent("A", { altKey: false });
    const hotkey: Hotkey = { alt: true, keys: ["a"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it("returns true for mod key when metaKey is pressed (mac)", () => {
    const event = createKeyboardEvent("Meta", { metaKey: true });
    const hotkey: Hotkey = { mod: true };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("returns true for mod key when ctrlKey is pressed (non-mac)", () => {
    const event = createKeyboardEvent("Control", { ctrlKey: true });
    const hotkey: Hotkey = { mod: true };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("matches the intended key when Option changes it on an AZERTY layout", () => {
    const event = createKeyboardEvent("µ", {
      altKey: true,
      code: "Semicolon",
      keyCode: 77,
      metaKey: true,
    });
    const hotkey: Hotkey = {
      alt: true,
      ctrl: false,
      keys: ["m"],
      meta: false,
      mod: true,
      shift: false,
    };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("does not alias an AZERTY physical key to its QWERTY letter", () => {
    const event = createKeyboardEvent("a", {
      code: "KeyQ",
      keyCode: 65,
    });
    const hotkey: Hotkey = { keys: ["q"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it("does not alias a function key through its legacy key code", () => {
    const event = createKeyboardEvent("F4", {
      altKey: true,
      code: "F4",
      keyCode: 115,
    });
    const hotkey: Hotkey = { alt: true, keys: ["s"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it("does not alias a numpad key through its legacy key code", () => {
    const event = createKeyboardEvent("1", {
      altKey: true,
      code: "Numpad1",
      keyCode: 97,
    });
    const hotkey: Hotkey = { alt: true, keys: ["a"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it("returns false if neither meta nor ctrl is pressed for mod", () => {
    const event = createKeyboardEvent("K");
    const hotkey: Hotkey = { mod: true, keys: ["k"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it("returns true when all modifiers and keys match", () => {
    const event = createKeyboardEvent("S", {
      ctrlKey: true,
      shiftKey: true,
    });

    pressKeys("ctrl", "shift", "s");

    const hotkey: Hotkey = {
      ctrl: true,
      shift: true,
      keys: ["s"],
    };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("returns false when required keys are not in currently pressed keys", () => {
    const event = createKeyboardEvent("V", {
      ctrlKey: true,
    });

    pressKeys("ctrl", "v");

    const hotkey: Hotkey = {
      ctrl: true,
      keys: ["b", "v"],
    };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it("returns true if only modifiers are required and they match", () => {
    const event = createKeyboardEvent("Control", {
      ctrlKey: true,
    });

    const hotkey: Hotkey = {
      ctrl: true,
    };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("handles mapped keys like ArrowUp", () => {
    const event = createKeyboardEvent("ArrowUp");
    const hotkey: Hotkey = { keys: ["arrowup"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it("ignores unrelated keys", () => {
    const event = createKeyboardEvent("KeyX");
    const hotkey: Hotkey = { keys: ["a"] };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(false);
  });

  it('does not reject events with key "Unknown" (browser synthetic catch-all)', () => {
    // "Unknown" is a browser-synthetic key value that should pass the early
    // guard and not be treated as an unrecognised key that short-circuits to false.
    const event = createKeyboardEvent("Unknown", { ctrlKey: true });
    const hotkey: Hotkey = { ctrl: true };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });

  it('does not reject events with key "OS" (Firefox Windows/Super key)', () => {
    // Firefox fires key="OS" for the Windows/Super key. It lives in
    // IGNORED_KEY_VALUES so it is not blocked by the early key-match guard,
    // and the meta check explicitly allows it through even when meta !== metaKey.
    const event = createKeyboardEvent("OS", { metaKey: true });
    const hotkey: Hotkey = { meta: true };

    expect(isHotkeyMatchingKeyboardEvent(event, hotkey)).toBe(true);
  });
});
