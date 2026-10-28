import type { StoppableEvent } from "./types";

/**
 * Stops further propagation of an event through the event chain.
 *
 * This utility function ensures that the provided event is fully halted by using:
 * - `stopPropagation()` (prevents the event from bubbling up the DOM)
 * - `preventDefault()` (stops the browser's default behavior for the event)
 * - `stopImmediatePropagation()` (prevents any other listeners of the same event from being called)
 *
 * @param event - The event object implementing `StoppableEvent`(e.g. `KeyboardEvent`) that needs to be stopped.
 */
export function stopEvent(event: StoppableEvent): void {
  event.stopPropagation();
  event.preventDefault();
  event.stopImmediatePropagation();
}
