/**
 * A `Set` containing the currently pressed keyboard keys.
 *
 * @internal
 * @remarks Keys are stored in lowercase for case-insensitive comparisons.
 */
const currentlyPressedKeys: Set<string> = new Set<string>();

/**
 * Checks if all of the specified hotkeys are currently pressed.
 *
 * @param hotkeys - An array of key names (representing a hotkey) to check, such as `["ctrl", "s"]`.
 *                  Each key is normalized to lowercase and trimmed before comparison.
 * @returns `true` if every keys in the list is currently pressed, `false` otherwise.
 */
export function isHotkeyPressed(hotkeys: readonly string[]): boolean {
  return hotkeys.every((hotkey) =>
    currentlyPressedKeys.has(hotkey.trim().toLowerCase()),
  );
}

/**
 * Adds a key to the set of currently pressed keys.
 *
 * @param key - The name of the key to add. It is converted to lowercase before being added.
 */
export function pushToCurrentlyPressedKeys(key: string): void {
  currentlyPressedKeys.add(key.toLowerCase());
}

/**
 * Removes a key from the set of currently pressed keys.
 *
 * @param key - The name of the key to remove. It is converted to lowercase before removal.
 */
export function removeFromCurrentlyPressedKeys(key: string): void {
  if (key === "meta") {
    currentlyPressedKeys.clear();
  } else {
    currentlyPressedKeys.delete(key.toLowerCase());
  }
}
