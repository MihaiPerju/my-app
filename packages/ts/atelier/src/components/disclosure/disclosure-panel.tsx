"use client";

import { cn } from "@mistralai/ui/utils";
import type { HTMLAttributes, ReactNode, TransitionEventHandler } from "react";
import { Activity, useCallback, useEffect, useReducer, useRef } from "react";

import { disclosureReducer } from "./presence";

export type { DisclosureEvent, DisclosurePhase } from "./presence";
export { disclosureReducer } from "./presence";

/**
 * Whether panel content stays in the DOM while collapsed.
 * - `activity` — mounted on first open, then kept in a hidden `<Activity>`.
 *   State survives collapse; effects and rendering are paused.
 * - `unmount` — removed once the collapse animation finishes.
 * - `mounted` — always rendered. The only option that keeps a live panel
 *   (a streaming log, a running timer) updating while collapsed.
 */
export type DisclosurePresence = "activity" | "mounted" | "unmount";

export interface DisclosurePanelProps extends Omit<HTMLAttributes<HTMLDivElement>, "color"> {
  /** Expanded state. Owned by whatever renders the trigger. */
  isOpen: boolean;
  /** @default "activity" */
  presence?: DisclosurePresence;
  /** Applied to the content element, for the trigger's `aria-controls`. */
  contentId?: string;
  /** Classes for the collapsing frame — use this to place the panel. */
  frameClassName?: string;
  children: ReactNode;
}

/**
 * A disclosure panel that animates its own height open and closed.
 *
 * `className` and any extra props go to the content; `frameClassName` styles
 * the collapsing box around it. Pair with a button that sets `aria-expanded`
 * and `aria-controls={contentId}` — the panel takes no accessible role of its
 * own, so each open row does not add a landmark.
 */
export function DisclosurePanel({
  children,
  className,
  contentId,
  frameClassName,
  isOpen,
  presence = "activity",
  ...rest
}: DisclosurePanelProps): ReactNode {
  const [phase, dispatch] = useReducer(disclosureReducer, isOpen ? "present" : "pristine");

  // Reconcile the `isOpen` prop into the machine. Render-phase dispatch is the
  // supported idiom for adjusting state to a prop; it also mounts content in the
  // same commit the open animation starts (no first-frame flash).
  if (isOpen && phase !== "present") {
    dispatch("open");
  } else if (!isOpen && phase === "present") {
    dispatch("close");
  }

  const isPresent = phase === "present" || phase === "exiting";

  // A 0s transition never starts, so `transitionend` never fires and the phase
  // would strand in `exiting` with content mounted forever. That is the normal
  // case under reduced motion, and callers can force it too, so read the real
  // duration off the element rather than inferring it. An effect rather than a
  // layout effect: the panel is already collapsed, so settling a frame later is
  // invisible, and it keeps SSR quiet.
  const frameRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (phase !== "exiting") return;
    const node = frameRef.current;
    if (node && Number.parseFloat(getComputedStyle(node).transitionDuration) === 0) {
      dispatch("exitEnd");
    }
  }, [phase]);

  const handleTransitionEnd = useCallback<TransitionEventHandler<HTMLDivElement>>(
    (event) => {
      if (event.target !== event.currentTarget) return;
      if (event.propertyName !== "grid-template-rows") return;
      if (!isOpen) dispatch("exitEnd");
    },
    [isOpen],
  );

  let rendered: ReactNode = children;
  if (presence === "unmount") {
    rendered = isPresent ? children : null;
  } else if (presence === "activity") {
    // `pristine` means never opened, so there is nothing to keep alive yet.
    rendered =
      phase === "pristine" ? null : (
        <Activity mode={isPresent ? "visible" : "hidden"}>{children}</Activity>
      );
  }

  const state = isOpen ? "open" : "closed";

  return (
    <div
      ref={frameRef}
      data-disclosure-panel=""
      data-state={state}
      className={cn(
        "grid contain-[layout_paint]",
        "transition-[grid-template-rows] duration-300 ease-[cubic-bezier(0,0,0,1)] motion-reduce:transition-none",
        isOpen ? "grid-rows-[1fr]" : "grid-rows-[0fr]",
        frameClassName,
      )}
      onTransitionEnd={handleTransitionEnd}
    >
      <div
        {...rest}
        id={contentId}
        data-disclosure-content=""
        data-state={state}
        inert={isOpen ? undefined : true}
        className={cn("min-h-0 overflow-clip", className)}
      >
        {rendered}
      </div>
    </div>
  );
}
DisclosurePanel.displayName = "DisclosurePanel";
