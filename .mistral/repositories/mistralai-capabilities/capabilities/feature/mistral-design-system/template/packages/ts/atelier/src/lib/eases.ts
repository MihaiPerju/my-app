import { cubicBezier } from "framer-motion";

/**
 * Mistral motion easings and durations.
 *
 * Compose an `EASE_*` curve with a `DURATION_*` for a Framer Motion `transition`
 * (`{ duration, ease }`). For Tailwind arbitrary values use the CSS cubic-bezier
 * noted on each. Durations are in seconds (Framer's unit).
 */

/** Micro-interactions — buttons, toggles, feedback. */
export const DURATION_FAST = 0.16;
/** General UI and layout/presence transitions. */
export const DURATION_BASE = 0.3;
/** Emphasis; long enough to let an overshoot settle. */
export const DURATION_SLOW = 0.5;

/**
 * Strong ease-out — the general-purpose UI curve.
 * CSS: `ease-[cubic-bezier(0.22,1,0.36,1)]`.
 */
export const EASE_OUT_QUINT = cubicBezier(0.22, 1, 0.36, 1);

/**
 * Quick ease-out for micro-interactions.
 * CSS: `ease-[cubic-bezier(0,0.55,0.45,1)]`.
 */
export const EASE_OUT_CIRC = cubicBezier(0, 0.55, 0.45, 1);

/**
 * Ease-out with overshoot — playful emphasis. Backs past the target once and
 * settles (not a multi-bounce).
 * CSS: `ease-[cubic-bezier(0.34,1.56,0.64,1)]`.
 */
export const EASE_OUT_BACK = cubicBezier(0.34, 1.56, 0.64, 1);

/**
 * Strong ease-in-out — for elements *moving/morphing on screen* (not entering or
 * exiting), e.g. a FLIP reflow settling into new positions, where a pure ease-out
 * would start too abruptly.
 * CSS: `ease-[cubic-bezier(0.77,0,0.175,1)]`.
 */
export const EASE_IN_OUT = cubicBezier(0.77, 0, 0.175, 1);
