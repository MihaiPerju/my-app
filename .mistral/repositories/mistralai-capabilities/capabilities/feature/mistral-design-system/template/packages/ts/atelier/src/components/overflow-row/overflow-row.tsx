"use client";

import { cn } from "@mistralai/ui/utils";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import type { Variants } from "framer-motion";
import type { ReactNode } from "react";
import { memo, useEffect, useMemo, useRef, useState } from "react";

import { DURATION_FAST, EASE_IN_OUT, EASE_OUT_CIRC } from "../../lib/eases";

/** Data needed to render one item and announce it to assistive technology. */
export interface OverflowRowItem {
  key: string;
  name: string;
}

export interface OverflowRowProps<T extends OverflowRowItem> {
  /** Items in visual and reading order. Omit to render no row. */
  items?: T[];
  /** Number of items shown before the remainder is grouped into an overflow token. @default 3 */
  maxVisible?: number;
  /** Spacing or overlap classes for the visible tiles. */
  className?: string;
  /** Classes controlling each tile's shape, size, and clipping. */
  itemClassName?: string;
  /** Accessible name for the set, such as "Connected integrations". */
  label: string;
  /** Renders the content inside each visible tile. */
  renderItem: (item: T) => ReactNode;
  /** Replaces the default `+N` token. Receives the hidden count and items. */
  renderOverflow?: (overflowCount: number, hiddenItems: T[]) => ReactNode;
}

const OVERFLOW_ROW_MAX_VISIBLE = 3;

// Exit (element leaving) uses ease-out; the neighbours' `layout` reflow (tiles
// moving on screen) uses ease-in-out, which a pure ease-out would start too
// abruptly. Enter is the Tailwind `starting:` classes below.
const TILE_TRANSITION = {
  duration: DURATION_FAST,
  ease: EASE_OUT_CIRC,
  layout: { duration: DURATION_FAST, ease: EASE_IN_OUT },
};

// Enter animation — CSS only, via Tailwind's `starting:` variant, so it runs on
// first paint and every insert with no JS. `motion-safe:` gates the scale/slide,
// leaving reduced-motion users a plain opacity cross-fade.
//
// Enter and exit touch different CSS properties so they never clash: Tailwind v4
// `scale-*`/`translate-*` write the independent `scale`/`translate` properties,
// while framer's exit + FLIP drive `transform`. So the transition names its props
// explicitly (opacity/scale/translate), never the `transition` shorthand — that
// list also covers `transform`.
//
// `duration-160` and the bezier are literals (not DURATION_FAST/EASE_OUT_CIRC) so
// Tailwind can statically extract the arbitrary utilities.
const ENTER_BASE =
  "transition-opacity duration-160 ease-[cubic-bezier(0,.55,.45,1)] starting:opacity-0 " +
  "motion-safe:transition-[opacity,scale,translate] motion-safe:scale-100 motion-safe:translate-x-0 motion-safe:starting:scale-85";
// Tiles slide in from the inline-end, the token from the inline-start, so the `+N`
// reads as folding off the end. Both mirror under RTL; each exit reverses its enter.
const ENTER_TILE = `${ENTER_BASE} motion-safe:starting:translate-x-1.5 motion-safe:rtl:starting:-translate-x-1.5`;
const ENTER_TOKEN = `${ENTER_BASE} motion-safe:starting:-translate-x-1.5 motion-safe:rtl:starting:translate-x-1.5`;

// `x`/`scale` write `transform` (framer's), not the enter's native
// `scale`/`translate`. `x` is *physical* px, so its sign is resolved against the
// row's direction at render (`dirSign` below) to mirror the enter's logical
// `translate-x`/`rtl:` classes.
const EXIT_SHIFT = 6;
const EXIT_REDUCED = { opacity: 0 };

// Token value roll: on a count change (`+3 → +4`) the token stays mounted and
// only its value rolls. Blur masks the crossfade so the two values read as one
// morph, not two overlapping strings. Reduced motion drops the roll for opacity.
const TOKEN_ROLL: Variants = {
  animate: { filter: "blur(0px)", opacity: 1, y: "0%" },
  exit: { filter: "blur(1px)", opacity: 0, y: "-50%" },
  initial: { filter: "blur(1px)", opacity: 0, y: "50%" },
};
const TOKEN_ROLL_REDUCED: Variants = {
  animate: { opacity: 1 },
  exit: { opacity: 0 },
  initial: { opacity: 0 },
};

/**
 * Displays a row of tiles and groups items beyond `maxVisible` into an overflow
 * token. Use it for people, teams, integrations, or other compact collections.
 *
 * The row renders at most `maxVisible` tiles plus one overflow token, regardless
 * of how many items are supplied. Provide `renderOverflow` when the default
 * `+N` label is not appropriate for your interface.
 */
export function OverflowRow<T extends OverflowRowItem>({
  className,
  itemClassName,
  items,
  label,
  maxVisible = OVERFLOW_ROW_MAX_VISIBLE,
  renderItem,
  renderOverflow,
}: OverflowRowProps<T>): ReactNode {
  const prefersReducedMotion = useReducedMotion() === true;

  // Resolve writing direction from the *computed* style (honours an inherited
  // `dir`) so the physical exit `x` can flip sign under RTL. Read once on mount:
  // direction is stable, and exit only fires after interaction, well after this.
  const rowRef = useRef<HTMLDivElement>(null);
  const [rtl, setRtl] = useState(false);
  useEffect(() => {
    const el = rowRef.current;
    if (el) {
      setRtl(getComputedStyle(el).direction === "rtl");
    }
  }, []);
  const dirSign = rtl ? -1 : 1;

  // Memoized so the `exit` prop keeps a stable reference across renders; hoisted
  // above the early return to keep the hook call unconditional.
  const tileExit = useMemo(
    () =>
      prefersReducedMotion ? EXIT_REDUCED : { opacity: 0, scale: 0.85, x: EXIT_SHIFT * dirSign },
    [prefersReducedMotion, dirSign],
  );
  const tokenExit = useMemo(
    () =>
      prefersReducedMotion ? EXIT_REDUCED : { opacity: 0, scale: 0.85, x: -EXIT_SHIFT * dirSign },
    [prefersReducedMotion, dirSign],
  );

  // Bail only when `items` is absent. An empty array still renders the container so
  // a set that drains to 0 keeps the row mounted and its last tile can play its
  // exit. Reserve the row's height yourself if it can empty — the height depends on
  // tile size, which only the consumer knows.
  if (!items) {
    return null;
  }

  const cap = Math.max(0, maxVisible);
  const visibleItems = items.slice(0, cap);
  const overflowCount = Math.max(0, items.length - cap);
  const hiddenItems = renderOverflow ? items.slice(cap) : [];

  // When the row empties, `popLayout` would pull the last tile/token out of flow,
  // collapsing the flex line to 0px tall while the exit is still visible. Keep that
  // final exit in flow so it shrinks/slides from its own x-axis instead of dropping
  // from the collapsed row centerline.
  const tilePresenceMode = visibleItems.length === 0 ? "sync" : "popLayout";
  const tokenPresenceMode = visibleItems.length === 0 && overflowCount === 0 ? "sync" : "popLayout";

  // Under reduced motion, drop scale/x and the FLIP `layout`, cross-fading opacity
  // only. Disabling `layout` stops the FLIP transform on neighbours; the enter's
  // `motion-safe:` classes mirror this on the CSS side.
  const layout = prefersReducedMotion ? false : "position";

  return (
    // `gap-1.5` is the fixed space before the overflow token, so consumer tile-spacing
    // (on the `ul`) can't pull the token under a tile.
    <div ref={rowRef} className="relative inline-flex items-center gap-1.5">
      {/* The tiles are the list; consumer spacing/overlap (`className`) lives here.
          `initial={false}` keeps Framer off the enter path (CSS owns it) so it animates
          only exit. `popLayout` pulls exiting tiles out of flow so survivors FLIP into
          place with a GPU-composited transform. */}
      <ul aria-label={label} className={cn("relative inline-flex items-center", className)}>
        <AnimatePresence initial={false} mode={tilePresenceMode}>
          {visibleItems.map((item) => (
            <motion.li
              key={item.key}
              aria-label={item.name}
              className={cn(
                ENTER_TILE,
                "flex shrink-0 items-center justify-center overflow-hidden",
                itemClassName,
              )}
              exit={tileExit}
              layout={layout}
              transition={TILE_TRANSITION}
            >
              {renderItem(item)}
            </motion.li>
          ))}
        </AnimatePresence>
      </ul>

      {/* Overflow token — a sibling summary (not a list item), kept clear of the tiles'
          spacing. Its presence context folds it in/out only at the 0↔1 boundary; a
          changing count keeps it mounted and rolls just the value inside (`TokenRoll`
          or the consumer's `renderOverflow`). The default token is only a summary;
          consumers that need the hidden list can expose it through `renderOverflow`. */}
      <AnimatePresence initial={false} mode={tokenPresenceMode}>
        {overflowCount > 0 && (
          <motion.span
            key="overflow"
            aria-label={`${overflowCount} more items not shown`}
            className={cn(ENTER_TOKEN, "flex shrink-0 items-center justify-center")}
            exit={tokenExit}
            layout={layout}
            transition={TILE_TRANSITION}
          >
            {renderOverflow ? (
              renderOverflow(overflowCount, hiddenItems)
            ) : (
              // Default token: a rolling `+N`. `renderOverflow` replaces this, so the
              // default's styling lives here, not on the animated wrapper above.
              <span className="text-subtle text-xs leading-4 font-medium">
                <TokenRoll reduced={prefersReducedMotion}>{`+${overflowCount}`}</TokenRoll>
              </span>
            )}
          </motion.span>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * Rolls a short string in place when its value changes. Data-driven — `children`
 * doubles as the `key`, so it animates only on a real value change, never on a timer.
 *
 * The two values stack in one `inline-grid` cell (`col/row-start-1`) so they overlap
 * in flow and stay measurable; `layout` then animates the width between differing
 * lengths (`+9 → +10`) instead of snapping. `tabular-nums` stops digit jitter
 * mid-roll. Under reduced motion this degrades to an opacity crossfade with `layout`
 * disabled.
 *
 * Memoized because `layout` makes framer measure this box (a `getBoundingClientRect`
 * read) on every render, so an unrelated parent rerender would force a reflow even
 * when the value is unchanged. `memo` skips that unless `children`/`reduced` change.
 */
function TokenRollInner({ children, reduced }: { children: string; reduced: boolean }): ReactNode {
  const variants = reduced ? TOKEN_ROLL_REDUCED : TOKEN_ROLL;

  return (
    <motion.span
      className="relative inline-grid overflow-hidden align-baseline tabular-nums"
      layout={!reduced}
      transition={TILE_TRANSITION}
    >
      {/* `popLayout` pulls the exiting value out of flow so the wrapper sizes to the
          incoming value and `layout` animates cleanly to it. */}
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={children}
          animate="animate"
          className="col-start-1 row-start-1 whitespace-nowrap"
          exit="exit"
          initial="initial"
          transition={TILE_TRANSITION}
          variants={variants}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </motion.span>
  );
}

const TokenRoll = memo(TokenRollInner);
