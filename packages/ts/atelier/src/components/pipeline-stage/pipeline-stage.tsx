"use client";

import { cn } from "@mistralai/ui/utils";
import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";

import { AgentStatusIcon, AGENT_STATUS_LABELS } from "../agent-status-icon/agent-status-icon";
import type { PipelineStageItem, PipelineStageProps, PipelineStageStatus } from "./types";

export type { PipelineStageItem, PipelineStageProps, PipelineStageStatus } from "./types";

/** `DURATION_SLOW` on `EASE_OUT_QUINT` (see `lib/eases`). */
const TRANSITION_CLASS =
  "duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none";

const STATUS_LABELS: Record<PipelineStageStatus, string> = {
  pending: AGENT_STATUS_LABELS.pending,
  running: "In progress",
  completed: AGENT_STATUS_LABELS.completed,
  failed: AGENT_STATUS_LABELS.failed,
};

/**
 * Width floor per stage, holding the label legible (~4 characters plus an
 * ellipsis) once proportional widths get tight. It is per-status because a
 * stage that has run also renders a `shrink-0` duration that takes its width
 * off the top, leaving less for the label than a pending stage has. In `rem`,
 * not px, so the floor scales with the text it protects.
 *
 * These cap proportionality: once `sum(floors) + gaps` exceeds the container,
 * every stage clamps and the track scrolls.
 */
const MIN_STAGE_WIDTH_REM = {
  pending: 5,
  running: 7,
  completed: 7,
  failed: 7,
} satisfies Record<PipelineStageStatus, number>;

/**
 * A status change steps the floor by 2.5rem, which reads as a glitch if it
 * snaps. `DURATION_BASE` on `EASE_IN_OUT` (see `lib/eases`): a reflow settling
 * into new positions, and the curve least like the linear ramp of a running
 * stage's duration — so the expansion doesn't read as a duration jump.
 */
const FLOOR_TRANSITION_CLASS =
  "transition-[min-width] duration-300 ease-[cubic-bezier(0.77,0,0.175,1)] motion-reduce:transition-none";

function stageLabelClass(status: PipelineStageStatus): string {
  let tone = "text-muted";
  if (status === "running") {
    tone = "text-muted animate-shimmer-text";
  } else if (status === "failed") {
    tone = "text-destructive";
  } else if (status === "completed") {
    tone = "text-default";
  }
  return cn("min-w-0 truncate text-sm font-medium", tone);
}

function formatDuration(duration: number | undefined): string | null {
  if (duration == null || !Number.isFinite(duration) || duration < 0) {
    return null;
  }
  const seconds = Math.round(duration / 1000);
  if (seconds < 60) {
    return `${seconds}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const rem = seconds % 60;
  return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
}

/** Displays sequential work as a horizontal pipeline with status and duration. */
export function PipelineStage({
  label = "Pipeline",
  className,
  children,
}: PipelineStageProps): ReactNode {
  return (
    <div data-pipeline-stage="" className={cn("flex w-full min-w-0 flex-col", className)}>
      {/* `overflow-y-hidden` (forced: `overflow-x-auto` makes a `visible` y-axis
          compute to `auto`) clips at the padding box, and `ring-*` is an outset
          box-shadow. `p-1` reserves 4px so the focus-visible ring renders unclipped. */}
      <div className="flex w-full min-w-0 overflow-x-auto overflow-y-hidden p-1">
        <ol aria-label={label} className="flex min-w-full list-none items-stretch gap-2">
          {children}
        </ol>
      </div>
    </div>
  );
}

PipelineStage.Stage = function Stage({
  label,
  status,
  duration,
  icon,
  interactive,
  onClick,
  isActive = false,
}: PipelineStageItem): ReactNode {
  const durationText = formatDuration(duration);

  const stageStyle = useMemo<CSSProperties>(
    () => ({
      flexBasis: 0,
      flexGrow: status === "pending" || duration == null ? 0 : duration,
      minWidth: `${MIN_STAGE_WIDTH_REM[status]}rem`,
    }),
    [status, duration],
  );

  const rowClassName = cn(
    "@container flex min-h-10 min-w-0 shrink-0 items-center gap-2 rounded-md border px-3 py-2",
    "border-basic-gray-alpha-10 bg-basic-white",
    interactive && "cursor-pointer transition-colors hover:bg-basic-gray-alpha-5",
    isActive && "border-strong",
    TRANSITION_CLASS,
  );

  const inner = (
    <>
      <span className="flex size-4 shrink-0 items-center justify-center [&>svg]:size-4">
        <AgentStatusIcon icon={icon} label={STATUS_LABELS[status]} status={status} />
      </span>
      <dl className="flex min-w-0 flex-1 items-center gap-2">
        <dt className="sr-only">Stage</dt>
        <dd className={stageLabelClass(status)}>{label}</dd>
        {durationText == null ? null : (
          <>
            <dt className="sr-only">Duration</dt>
            <dd className="ms-auto shrink-0 text-sm text-muted tabular-nums">
              <time dateTime={`${duration}ms`}>{durationText}</time>
            </dd>
          </>
        )}
      </dl>
    </>
  );

  return (
    <li
      data-status={status}
      data-active={isActive || undefined}
      data-interactive={interactive ?? undefined}
      aria-current={isActive ? "step" : undefined}
      style={stageStyle}
      className={cn("shrink-0", FLOOR_TRANSITION_CLASS)}
    >
      {interactive ? (
        <button
          type="button"
          onClick={onClick}
          className={cn(
            rowClassName,
            "w-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-default",
          )}
        >
          {inner}
        </button>
      ) : (
        <div className={rowClassName}>{inner}</div>
      )}
    </li>
  );
};
