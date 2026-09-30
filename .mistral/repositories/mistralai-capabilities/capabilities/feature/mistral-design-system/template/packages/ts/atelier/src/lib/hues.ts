/**
 * Categorical accent hues.
 *
 * Observability surfaces color by *identity*, not by state: an agent, a span
 * kind, or a metric keeps the same hue across every view so the eye can track
 * it. That is a different axis from the semantic status colors
 * (`text-success`, `text-destructive`, …), which mean one specific thing — so
 * these deliberately carry no meaning of their own.
 *
 * The maps are static string literals rather than template strings because
 * Tailwind scans source text: `bg-basic-${hue}-accent` would never be emitted.
 */

/** A categorical hue from the Mistral `basic` palette. */
export type AccentHue =
  | "gray"
  | "blue"
  | "cyan"
  | "emerald"
  | "green"
  | "lime"
  | "orange"
  | "orangebright"
  | "pink"
  | "pinkdeep"
  | "purple"
  | "purpledeep"
  | "red"
  | "rose"
  | "sky"
  | "teal"
  | "violet"
  | "yellow";

/** Saturated fill (palette step 500 in both themes) — bars, dots, marks. */
export const ACCENT_FILL: Record<AccentHue, string> = {
  gray: "bg-basic-gray-accent",
  blue: "bg-basic-blue-accent",
  cyan: "bg-basic-cyan-accent",
  emerald: "bg-basic-emerald-accent",
  green: "bg-basic-green-accent",
  lime: "bg-basic-lime-accent",
  orange: "bg-basic-orange-accent",
  orangebright: "bg-basic-orangebright-accent",
  pink: "bg-basic-pink-accent",
  pinkdeep: "bg-basic-pinkdeep-accent",
  purple: "bg-basic-purple-accent",
  purpledeep: "bg-basic-purpledeep-accent",
  red: "bg-basic-red-accent",
  rose: "bg-basic-rose-accent",
  sky: "bg-basic-sky-accent",
  teal: "bg-basic-teal-accent",
  violet: "bg-basic-violet-accent",
  yellow: "bg-basic-yellow-accent",
};

/**
 * Tinted surface paired with its readable foreground. Theme-aware: `subtle`
 * and `contrast` swap ends of the ramp in dark mode, so contrast holds.
 */
export const ACCENT_SURFACE: Record<AccentHue, string> = {
  gray: "bg-basic-gray-subtle text-basic-gray-contrast",
  blue: "bg-basic-blue-subtle text-basic-blue-contrast",
  cyan: "bg-basic-cyan-subtle text-basic-cyan-contrast",
  emerald: "bg-basic-emerald-subtle text-basic-emerald-contrast",
  green: "bg-basic-green-subtle text-basic-green-contrast",
  lime: "bg-basic-lime-subtle text-basic-lime-contrast",
  orange: "bg-basic-orange-subtle text-basic-orange-contrast",
  orangebright: "bg-basic-orangebright-subtle text-basic-orangebright-contrast",
  pink: "bg-basic-pink-subtle text-basic-pink-contrast",
  pinkdeep: "bg-basic-pinkdeep-subtle text-basic-pinkdeep-contrast",
  purple: "bg-basic-purple-subtle text-basic-purple-contrast",
  purpledeep: "bg-basic-purpledeep-subtle text-basic-purpledeep-contrast",
  red: "bg-basic-red-subtle text-basic-red-contrast",
  rose: "bg-basic-rose-subtle text-basic-rose-contrast",
  sky: "bg-basic-sky-subtle text-basic-sky-contrast",
  teal: "bg-basic-teal-subtle text-basic-teal-contrast",
  violet: "bg-basic-violet-subtle text-basic-violet-contrast",
  yellow: "bg-basic-yellow-subtle text-basic-yellow-contrast",
};

const HUES = Object.keys(ACCENT_FILL) as AccentHue[];

/**
 * Deterministic hue for a string key, so the same agent, span kind, or metric
 * gets the same color everywhere without a hand-maintained lookup table.
 *
 * FNV-1a: stable across runs and platforms (unlike a `hashCode`-style sum, it
 * avoids collisions between anagrams like `read`/`dear`). Not cryptographic.
 */
export function hueFromKey(key: string): AccentHue {
  let hash = 0x81_1c_9d_c5;
  for (let index = 0; index < key.length; index += 1) {
    hash ^= key.charCodeAt(index);
    hash = Math.imul(hash, 0x01_00_01_93);
  }
  return HUES[Math.abs(hash) % HUES.length]!;
}
