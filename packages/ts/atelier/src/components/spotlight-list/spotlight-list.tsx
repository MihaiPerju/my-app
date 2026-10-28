"use client";

import { cn } from "@mistralai/ui/utils";
import { useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, HTMLAttributes, PropsWithChildren, ReactNode } from "react";

// The bright band is symmetric about the midpoint because the active row is
// centred on it. Its radius is written from the measured row height, so the
// band covers the active row exactly whatever that row's height is, and both
// curve corners land in the inter-row gap.
const BRIGHT_RADIUS = "var(--spotlight-list-active-radius, 0px)";
const BRIGHT_TOP = `50% - (${BRIGHT_RADIUS})`;
const BRIGHT_BOTTOM = `50% + (${BRIGHT_RADIUS})`;
// Sampling count per ramp. Below ~5 the gradient bands; above ~12 only the
// string grows.
const RAMP_STOP_COUNT = 8;
// The alpha analogue of ease-out-quint: `1 - easeOutQuint(s)` is exactly
// `(1 - s) ** 5`. Brightness drops sharply next to the spotlight and then
// trails off, the same curve family as EASE_OUT_QUINT in `lib/eases`.
const FALLOFF_EXPONENT = 5;
// DURATION_SLOW + EASE_OUT_QUINT from `lib/eases`, kept literal so Tailwind
// can detect the arbitrary easing class.
const TRANSITION_CLASS =
  "duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

/**
 * Stops in layout order from `from` to `to`, with `bright` identifying the end
 * beside the spotlight. CSS has no easing for gradient stops, and a
 * linear ramp leaves a visible Mach band where it meets a flat region because
 * the alpha derivative jumps.
 */
function ramp(from: string, to: string, bright: "from" | "to"): string[] {
  return Array.from({ length: RAMP_STOP_COUNT + 1 }, (_, index) => {
    const t = index / RAMP_STOP_COUNT;
    const distance = bright === "to" ? 1 - t : t;
    // `rgb(0 0 0 / a)` rather than `transparent`: gradients interpolate in
    // premultiplied alpha, so both endpoints must stay black.
    const alpha = ((1 - distance) ** FALLOFF_EXPONENT).toFixed(3);

    return `rgb(0 0 0 / ${alpha}) calc(${from} + ((${to}) - (${from})) * ${t})`;
  });
}

/**
 * Both ramps run from a viewport edge inward to the bright band around the
 * active row, whose centre sits at the midpoint. Anchoring to 0%/100% rather
 * than to a fixed length means alpha reaches 0 exactly at the bounds at any
 * viewport height, and the curve is flat there — so no separate edge-fade layer
 * (and no `mask-composite`) is needed. The span between the ramps interpolates
 * 1 -> 1, so it needs no stops.
 */
const SPOTLIGHT_MASK = `linear-gradient(to bottom, ${[
  ...ramp("0%", BRIGHT_TOP, "to"),
  ...ramp(BRIGHT_BOTTOM, "100%", "from"),
].join(", ")})`;

/**
 * Set imperatively because rows may be wrapped components, and a keyed reorder
 * moves DOM nodes without changing the row count or the active index. The fade
 * is decoration, so every row stays in the accessibility tree and only the
 * current one carries semantic state.
 */
function markRows(rows: HTMLElement[], activeRow: HTMLElement | undefined): void {
  for (const row of rows) {
    const isActive = row === activeRow;

    row.toggleAttribute("data-active", isActive);
    if (isActive) {
      row.setAttribute("aria-current", "true");
    } else {
      row.removeAttribute("aria-current");
    }
  }
}

export type SpotlightListProps = PropsWithChildren<
  Omit<HTMLAttributes<HTMLDivElement>, "aria-label"> & {
    /** Zero-based index of the row to emphasize and center. */
    activeIndex: number;
    "aria-label": string;
  }
>;

export type SpotlightListItemProps = PropsWithChildren<HTMLAttributes<HTMLLIElement>>;

/**
 * The default row for `SpotlightList`. Plain `<li>` elements and components
 * that render one are also supported.
 */
export function SpotlightListItem({
  children,
  className,
  ...props
}: SpotlightListItemProps): ReactNode {
  return (
    <li {...props} className={cn("min-w-0", className)}>
      {children}
    </li>
  );
}

/**
 * Emphasizes the current item in a compact progress or status sequence while
 * keeping nearby items visible for context.
 *
 * Each direct child is one row and may have a different height. Rows must stay
 * direct children so the active index maps to the rendered sequence. The
 * viewport is `13rem` high by default; override its height with `className`.
 */
export function SpotlightList({
  activeIndex,
  "aria-label": ariaLabel,
  children,
  className,
  style,
  ...props
}: SpotlightListProps): ReactNode {
  const normalizedActiveIndex = Number.isFinite(activeIndex) ? Math.trunc(activeIndex) : 0;
  const viewportRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const previousActiveIndexRef = useRef(-1);
  // Stable object required by `react-perf/jsx-no-new-object-as-prop`; only the
  // caller-supplied style can change.
  const viewportStyle = useMemo<CSSProperties>(
    () => ({ maskImage: SPOTLIGHT_MASK, ...style }),
    [style],
  );

  // Deliberately runs after every render because the rendered DOM is the
  // dependency. Rows are whatever the browser laid out, so nothing here needs
  // to inspect `children`, which also keeps wrappers, fragments and conditional
  // rows working.
  // Writes straight to the DOM rather than through state, so positioning costs
  // no extra commit.
  useLayoutEffect(() => {
    const list = listRef.current;
    let observer: ResizeObserver | undefined;
    const disconnect = () => observer?.disconnect();

    if (!list) {
      return disconnect;
    }

    const rows = Array.from(list.children).filter(
      (row): row is HTMLElement => row instanceof HTMLElement,
    );
    // Use the laid-out row count as the bound rather than the React children.
    const activeRowIndex = Math.min(normalizedActiveIndex, Math.max(0, rows.length - 1));
    const activeRow = rows[activeRowIndex];

    markRows(rows, activeRow);

    // Animate only when the caller moves the spotlight. First paint should land
    // already anchored, and a layout shift should be corrected without sliding.
    const activeChanged =
      previousActiveIndexRef.current !== -1 && previousActiveIndexRef.current !== activeRowIndex;
    previousActiveIndexRef.current = activeRowIndex;

    const alignActiveRow = (animate: boolean) => {
      const radius = activeRow ? activeRow.offsetHeight / 2 : 0;

      // Sizes the mask's bright band to the active row. Written to the viewport
      // because that is where the mask lives, and left outside the guard below
      // because a row can change height without moving the track.
      viewportRef.current?.style.setProperty("--spotlight-list-active-radius", `${radius}px`);

      // Centres the active row on the midpoint, so the falloff has equal room
      // for completed and upcoming rows.
      const nextOffset = `${activeRow ? -(activeRow.offsetTop + radius) : 0}px`;

      // Re-observed rows report their current size immediately. Keep that
      // callback from disabling an index transition already in progress.
      if (list.style.getPropertyValue("--spotlight-list-offset") === nextOffset) {
        return;
      }

      // Empty string clears the inline value so the class takes over.
      list.style.transitionProperty = animate ? "" : "none";
      list.style.setProperty("--spotlight-list-offset", nextOffset);
    };

    alignActiveRow(activeChanged);

    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => alignActiveRow(false));
      // Rows above the active row affect its position, while the active row's
      // height determines its centre and the mask radius.
      for (const row of rows.slice(0, activeRowIndex + 1)) {
        observer.observe(row);
      }
    }

    return disconnect;
  });

  return (
    <div
      {...props}
      ref={viewportRef}
      data-spotlight-list=""
      // `overflow-clip` rather than `hidden`: it clips without becoming a
      // scroll container, so focusing an off-screen row cannot scroll the
      // viewport out of sync with the transform.
      className={cn("relative h-52 w-full min-w-0 overflow-clip", className)}
      style={viewportStyle}
    >
      <ul
        ref={listRef}
        aria-label={ariaLabel}
        // oxlint-disable-next-line jsx-a11y/no-redundant-roles -- Tailwind preflight sets `list-style: none`, which drops list semantics in Safari
        role="list"
        className={cn(
          "absolute inset-x-0 top-1/2 flex flex-col gap-2 [transform:translateY(var(--spotlight-list-offset,0px))] motion-safe:transition-transform",
          TRANSITION_CLASS,
        )}
      >
        {children}
      </ul>
    </div>
  );
}
