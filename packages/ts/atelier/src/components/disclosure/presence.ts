/**
 * Panel content lifecycle:
 * - `pristine` — never opened; content is not rendered.
 * - `present` — open, content mounted and visible.
 * - `exiting` — closing; content stays mounted so the collapse can animate out.
 * - `settled` — fully closed; content is unmounted, hidden, or still rendered,
 *   depending on the panel's presence mode.
 */
export type DisclosurePhase = "pristine" | "present" | "exiting" | "settled";

export type DisclosureEvent = "open" | "close" | "closeInstant" | "exitEnd";

/**
 * Pure state machine for a disclosure panel. Lives in its own module so the
 * lifecycle — the spot where mount/animation timing is easy to get wrong — is
 * unit-testable without rendering. `close` waits for the collapse animation to
 * end (`exitEnd`); `closeInstant` skips it when nothing animates.
 */
export function disclosureReducer(phase: DisclosurePhase, event: DisclosureEvent): DisclosurePhase {
  switch (event) {
    case "open":
      return "present";
    case "close":
      return phase === "present" ? "exiting" : phase;
    case "closeInstant":
      return "settled";
    case "exitEnd":
      return phase === "exiting" ? "settled" : phase;
    default:
      return phase;
  }
}
