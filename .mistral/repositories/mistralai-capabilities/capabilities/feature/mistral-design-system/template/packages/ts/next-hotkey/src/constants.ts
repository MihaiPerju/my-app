import type { Options } from "./types";

/**
 * The default configuration options for the hook.
 * Every property defined in `Options` must have a corresponding default.
 */
export const DEFAULT_OPTIONS = {
  capture: false,
  eventTarget: "document",
  isDisabled: false,
  preventDefault: false,
  stopPropagation: false,
  splitKey: "+",
} satisfies Required<Options>;

/**
 * Modifier keys that are reserved and cannot be used as a key.
 */
export const RESERVED_MODIFIER_KEYWORDS = [
  "alt",
  "control",
  "ctrl",
  "meta",
  "mod",
  "shift",
] as const;

/**
 * Key values that are skipped during single-key matching (modifier or browser-synthetic).
 * Includes "os" (old Firefox identifier for the Windows/Super key) and "unknown" (defensive catch-all).
 */
export const IGNORED_KEY_VALUES = [
  "ctrl",
  "control",
  "unknown",
  "meta",
  "alt",
  "shift",
  "os",
] as const;

/**
 * Keys that are mapped to a different key name.
 */
export const MAPPED_KEYS = {
  Control: "ctrl",
  down: "arrowdown",
  esc: "escape",
  left: "arrowleft",
  right: "arrowright",
  up: "arrowup",
} as const;
