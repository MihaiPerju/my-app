const DEFAULT_IS_MAC = false;

export const MOD_LABEL = "Ctrl";
export const ALT_LABEL = "Alt";

export function getModifierLabels(isMacPlatform: boolean): {
  altLabel: string;
  modLabel: string;
} {
  return {
    altLabel: isMacPlatform ? "\u2325" : ALT_LABEL,
    modLabel: isMacPlatform ? "\u2318" : MOD_LABEL,
  };
}

export function formatShortcutForPlatform(
  isMacPlatform: boolean,
  ...keys: string[]
): string {
  return keys.join(isMacPlatform ? "" : "+");
}

/**
 * Format a keyboard shortcut as a server-safe human-readable string.
 *
 * @example
 * formatShortcut(MOD_LABEL, "N") // -> "Ctrl+N"
 */
export function formatShortcut(...keys: string[]): string {
  return formatShortcutForPlatform(DEFAULT_IS_MAC, ...keys);
}
