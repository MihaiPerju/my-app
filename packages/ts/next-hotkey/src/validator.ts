import { IGNORED_KEY_VALUES } from "./constants";
import { normalizeKey } from "./parse";
import { isHotkeyPressed } from "./state";
import type { Hotkey } from "./types";

/**
 * Determines whether a `KeyboardEvent` matches the structure and criteria defined by a `Hotkey` object.
 *
 * @param event - The `KeyboardEvent` that was triggered, usually from a `keydown` or `keyup` listener.
 * @param hotkey - A `Hotkey` object defining the expected key combination and optional modifiers.
 *
 * @returns `true` if the keyboard event matches the hotkey definition; otherwise, `false`.
 *
 * @example
 * ```ts
 * const hotkey: Hotkey = {
 *   keys: ['k'],
 *   ctrl: true,
 * };
 *
 * window.addEventListener('keydown', (event) => {
 *   if (isHotkeyMatchingKeyboardEvent(event, hotkey)) {
 *     console.log('Ctrl + K was pressed!');
 *   }
 * });
 * ```
 *
 * @remarks
 * - The `mod` key is a special modifier that maps to `meta` on macOS and `ctrl` on other platforms.
 * - If multiple keys are defined in `hotkey.keys`, the function will check if all keys are currently pressed.
 */
export function isHotkeyMatchingKeyboardEvent(
  event: KeyboardEvent,
  hotkey: Hotkey,
): boolean {
  const { alt, meta, mod, shift, ctrl, keys } = hotkey;
  const { key: producedKey, code, ctrlKey, metaKey, shiftKey, altKey } = event;

  const normalizedKey = normalizeKey(producedKey);
  const normalizedCode = normalizeKey(code);
  // Option changes `key`, while `code` follows the physical layout. `keyCode`
  // preserves the intended letter for shortcuts on layouts such as AZERTY.
  const isLegacyAlphanumericKeyCode =
    (event.keyCode >= 48 && event.keyCode <= 57) ||
    (event.keyCode >= 65 && event.keyCode <= 90);
  const normalizedLegacyKey =
    altKey && isLegacyAlphanumericKeyCode
      ? normalizeKey(String.fromCharCode(event.keyCode))
      : "";
  const normalizedEventKeys = [
    normalizedKey,
    normalizedCode,
    normalizedLegacyKey,
  ];

  if (
    !keys?.some((key) => normalizedEventKeys.includes(key)) &&
    !(IGNORED_KEY_VALUES as readonly string[]).includes(normalizedKey)
  ) {
    return false;
  }

  if (alt !== undefined && alt !== altKey && normalizedKey !== "alt") {
    return false;
  }

  if (shift !== undefined && shift !== shiftKey && normalizedKey !== "shift") {
    return false;
  }

  // Mod is a special key name that is checking for meta on macOS and ctrl on other platforms
  if (mod) {
    if (!metaKey && !ctrlKey) {
      return false;
    }
  } else {
    if (
      meta !== undefined &&
      meta !== metaKey &&
      normalizedKey !== "meta" &&
      normalizedKey !== "os"
    ) {
      return false;
    }

    if (
      ctrl !== undefined &&
      ctrl !== ctrlKey &&
      normalizedKey !== "ctrl" &&
      normalizedKey !== "control"
    ) {
      return false;
    }
  }

  if (
    keys &&
    keys.length === 1 &&
    keys.some((key) => normalizedEventKeys.includes(key))
  ) {
    return true;
  } else if (keys) {
    return isHotkeyPressed(keys);
  }
  return true;
}
