"use client";

import { cn } from "@mistralai/ui/utils";
import { useEffect, useRef, useState } from "react";
import type { PropsWithChildren, ReactNode, TransitionEvent } from "react";

interface Layer {
  token: string | number;
  node: ReactNode;
}

export interface CrossFadeProps extends PropsWithChildren {
  /** Change this value whenever the displayed content changes. */
  token: string | number;
  /**
   * A `span` cannot legally contain a `div` or other flow content — use `div`
   * for anything richer than inline text.
   *
   * @default "span"
   */
  as?: "span" | "div";
  /** Also fade in the first paint, not just swaps. @default false */
  animateInitial?: boolean;
  /** Called once the outgoing layer has faded out and been removed. */
  onExitComplete?: () => void;
  /**
   * Classes for the wrapper, including an explicit width and height. The
   * content layers are positioned inside this box and content larger than it
   * is clipped.
   */
  className?: string;
}

/**
 * Smoothly replaces content when a value changes, such as a status icon that
 * moves between states.
 *
 * Give `className` an explicit size so the wrapper can contain its positioned
 * layers. The outgoing content is hidden from assistive technology while it
 * fades out.
 */
export function CrossFade({
  token,
  children,
  as: Box = "span",
  animateInitial = false,
  onExitComplete,
  className,
}: CrossFadeProps): ReactNode {
  const [current, setCurrent] = useState(token);
  const [exiting, setExiting] = useState<Layer | null>(null);

  const committedToken = useRef(token);
  const committedNode = useRef(children);
  useEffect(() => {
    committedToken.current = token;
    committedNode.current = children;
  });

  if (current !== token) {
    setCurrent(token);
    setExiting({ node: committedNode.current, token: committedToken.current });
  }

  // Listen on the *incoming* layer: an outgoing one whose `opacity: 1` was
  // never resolved skips its fade and strands itself in the DOM.
  function retireLayer(event: TransitionEvent<HTMLElement>) {
    if (event.propertyName === "opacity" && event.target === event.currentTarget) {
      retire();
    }
  }

  // A 0s transition never starts (per spec), so `transitionend`/`transitioncancel`
  // never fire — e.g. the `withTransitionSpeed` "Instant" toolbar pin forces
  // `transition-duration: 0ms`. Without this guard the exiting layer strands in
  // the DOM and `onExitComplete` never resolves. Attached only during a swap so
  // it never fires at rest or on first paint.
  function retireInstantIfZeroMs(node: HTMLElement | null) {
    if (!node) return;
    if (Number.parseFloat(getComputedStyle(node).transitionDuration) === 0) retire();
  }

  function retire() {
    setExiting(null);
    onExitComplete?.();
  }

  // One keyed list, not two JSX slots — React must reuse the incoming layer's
  // DOM node as the outgoing one, or there is no `opacity: 1` to fade from.
  const swapping = exiting !== null;
  const layers = exiting
    ? [
        { isExiting: true, key: exiting.token, node: exiting.node },
        { isExiting: false, key: token, node: children },
      ]
    : [{ isExiting: false, key: token, node: children }];

  const enterClass = swapping
    ? "opacity-100 mix-blend-plus-lighter starting:opacity-0"
    : animateInitial
      ? "opacity-100 starting:opacity-0"
      : "opacity-100";
  const onFadeEnd = swapping ? retireLayer : undefined;

  return (
    <Box
      className={cn(
        "relative isolate inline-block shrink-0 contain-layout contain-paint",
        className,
      )}
    >
      {layers.map(({ isExiting, key, node }) => (
        // Retiming must hit both layers (`[&>*]:duration-*`; `--tw-duration`
        // does not inherit) or their opacities stop summing to 1.
        <Box
          aria-hidden={isExiting || undefined}
          className={cn(
            "absolute inset-0 flex items-center justify-center transition-opacity ease-[cubic-bezier(0,.55,.45,1)]",
            isExiting ? "pointer-events-none opacity-0" : enterClass,
          )}
          data-layer={isExiting ? "previous" : "current"}
          key={key}
          onTransitionCancel={isExiting ? undefined : onFadeEnd}
          onTransitionEnd={isExiting ? undefined : onFadeEnd}
          ref={swapping && !isExiting ? retireInstantIfZeroMs : undefined}
        >
          {node}
        </Box>
      ))}
    </Box>
  );
}
