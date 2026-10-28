import { MAPPED_KEYS, RESERVED_MODIFIER_KEYWORDS } from "./constants";
import type { Hotkey, KeyboardModifiers } from "./types";

/**
 * Normalizes a key string by trimming whitespace and converting it to lowercase.
 *
 * @param key - The raw key name from a keyboard event.
 * @returns A standardized lowercase key string used for hotkey matching.
 */
export function normalizeKey(key: string): string {
  return (
    key in MAPPED_KEYS ? MAPPED_KEYS[key as keyof typeof MAPPED_KEYS] : key
  ).toLowerCase();
}

/**
 * Parses a hotkey string (e.g., `"Ctrl+Shift+K"`) into a structured `Hotkey` object.
 *
 * It detects known modifier keys (`ctrl`, `shift`, `alt`, `meta`, `mod`) and captures
 * non-modifier keys as part of the `keys` array. You can optionally provide a custom
 * separator (default is `+`).
 *
 * @param hotkey - The hotkey string to parse (e.g., `"Ctrl+Alt+S"`).
 * @param splitKey - The delimiter used to separate keys in the hotkey string (default is `+`).
 * @returns A `Hotkey` object containing boolean flags for modifiers and any non-modifier keys.
 *
 * @example
 * parseHotkey("Ctrl+Shift+K");
 * // {
 * //   ctrl: true,
 * //   shift: true,
 * //   alt: false,
 * //   meta: false,
 * //   mod: false,
 * //   keys: ["k"],
 * // }
 */
export function parseHotkey(hotkey: string, splitKey = "+"): Hotkey {
  const keys = hotkey.toLocaleLowerCase().split(splitKey).map(normalizeKey);

  const modifiers: KeyboardModifiers = {
    alt: keys.includes("alt"),
    ctrl: keys.includes("ctrl") || keys.includes("control"),
    shift: keys.includes("shift"),
    meta: keys.includes("meta"),
    mod: keys.includes("mod"),
  };

  const nonModifierKeys = keys.filter(
    (key) => !(RESERVED_MODIFIER_KEYWORDS as readonly string[]).includes(key),
  );

  return {
    ...modifiers,
    ...(nonModifierKeys.length > 0 && { keys: nonModifierKeys }),
  };
}
