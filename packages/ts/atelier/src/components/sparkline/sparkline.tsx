"use client";

import { cn } from "@mistralai/ui/utils";
import { useMemo } from "react";
import type { ReactNode } from "react";

import type { SparklineProps } from "./types";

export type { SparklineProps } from "./types";

// Margin so the stroke and end-caps never clip.
const PADDING = 1;

// The SVG fills its parent box, so these only define the coordinate space.
const VIEWBOX_WIDTH = 64;
const VIEWBOX_HEIGHT = 20;

interface Points {
  xs: number[];
  ys: number[];
  baseline: number;
  innerWidth: number;
}

// Normalize values into the viewBox coordinate space shared by every variant.
// Non-finite values clamp to the baseline so the polyline stays continuous.
// min===max renders a flat line at mid-height. Returns null below 2 points.
function buildPoints(values: number[]): Points | null {
  if (values.length < 2) {
    return null;
  }

  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (!Number.isFinite(v)) continue;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (min === Infinity) min = 0;
  if (max === -Infinity) max = 0;
  const span = max - min;

  const innerWidth = VIEWBOX_WIDTH - PADDING * 2;
  const innerHeight = VIEWBOX_HEIGHT - PADDING * 2;
  const stepX = innerWidth / (values.length - 1);
  const baseline = VIEWBOX_HEIGHT - PADDING;

  const xs: number[] = [];
  const ys: number[] = [];
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? Number.NaN;
    const ratio = Number.isFinite(value) ? (span === 0 ? 0.5 : (value - min) / span) : 0;
    xs.push(PADDING + index * stepX);
    // SVG y grows downward, so invert.
    ys.push(PADDING + (1 - ratio) * innerHeight);
  }

  return { xs, ys, baseline, innerWidth };
}

interface LineVariantProps {
  points: Points;
  strokeWidth: number;
  variant: "line" | "filled";
}

// Polyline stroke, optionally with a faint area polygon beneath it. `filled`
// adds the area; `line` is the stroke alone. SVG renders sub-pixel coordinates
// with anti-aliasing, so coordinates stay as raw floats — no rounding.
function LineVariant({ points, strokeWidth, variant }: LineVariantProps): ReactNode {
  const { xs, ys, baseline } = points;
  const linePoints = xs.map((x, i) => `${x},${ys[i]}`).join(" ");

  return (
    <>
      {variant === "filled" ? (
        <polygon
          points={`${xs[0]},${baseline} ${linePoints} ${xs[xs.length - 1]},${baseline}`}
          className="fill-current opacity-15"
          stroke="none"
        />
      ) : null}
      <polyline
        points={linePoints}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        vectorEffect="non-scaling-stroke"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </>
  );
}

interface BarsVariantProps {
  points: Points;
}

// One vertical bar per point. Uses a slot layout (one slot per point, bar
// centered in its slot with a gap) so bars fill the width without edge overflow
// — distinct from the line's point-at-position layout. Each bar is a closed
// rect path from its top to the shared baseline; raw floats keep widths/gaps
// uniform by construction (`xRight - xLeft === barWidth` exactly for every bar).
function BarsVariant({ points }: BarsVariantProps): ReactNode {
  const { ys, baseline, innerWidth } = points;
  const slotWidth = innerWidth / ys.length;
  const barWidth = Math.max(slotWidth * 0.85, 1);
  const halfBar = barWidth / 2;
  const d = ys
    .map((top, i) => {
      const cx = PADDING + (i + 0.5) * slotWidth;
      const xLeft = cx - halfBar;
      const xRight = cx + halfBar;
      return `M${xLeft},${top} H${xRight} V${baseline} H${xLeft} Z`;
    })
    .join(" ");

  return <path d={d} className="fill-current" stroke="none" />;
}

// "trend, N points, up/down/flat" from first vs last value.
function deriveLabel(values: number[]): string {
  const first = values[0] ?? 0;
  const last = values.at(-1) ?? 0;
  let direction: "up" | "down" | "flat";
  if (last > first) direction = "up";
  else if (last < first) direction = "down";
  else direction = "flat";
  return `trend, ${values.length} points, ${direction}`;
}

/**
 * Displays the direction of a numeric series in a compact chart for KPI tiles,
 * dashboards, and metric rows. Supports line, filled-area, and bar styles.
 */
export function Sparkline({
  values,
  strokeWidth = 1.5,
  variant = "line",
  className,
  label,
}: SparklineProps): ReactNode {
  // O(values). Memoize so a parent re-render doesn't recompute.
  const points = useMemo(() => buildPoints(values), [values]);

  if (values.length === 0) {
    return null;
  }

  const accessibleLabel = label ?? deriveLabel(values);
  const rootClassName = cn("h-full w-full", "text-icon-default-muted", className);

  return (
    <svg
      data-sparkline=""
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- SVG sparkline needs role="img" for aria-label
      role="img"
      aria-label={accessibleLabel}
      viewBox={`0 0 ${VIEWBOX_WIDTH} ${VIEWBOX_HEIGHT}`}
      preserveAspectRatio="none"
      className={rootClassName}
    >
      {points ? (
        variant === "bars" ? (
          <BarsVariant points={points} />
        ) : (
          <LineVariant points={points} strokeWidth={strokeWidth} variant={variant} />
        )
      ) : (
        <circle cx={PADDING} cy={VIEWBOX_HEIGHT / 2} r={strokeWidth / 2} className="fill-current" />
      )}
    </svg>
  );
}
