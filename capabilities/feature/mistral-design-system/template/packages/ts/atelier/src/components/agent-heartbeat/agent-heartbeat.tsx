"use client";

import { Badge } from "@mistralai/ui/badge";
import { TypographySpan } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";
import type { ReactNode } from "react";
import { useEffect, useState } from "react";

import { formatDurationMs } from "../../lib/format";
import { AgentStatusIcon } from "../agent-status-icon/agent-status-icon";
import { Sparkline } from "../sparkline/sparkline";

/** Run status derived from the time since the agent last emitted an event. */
export type HeartbeatState = "live" | "quiet" | "stalled" | "paused" | "done";

export interface AgentHeartbeatProps {
  /** Start timestamp in milliseconds. Drives the elapsed-time display. */
  startedAt: number;
  /** Most recent event timestamp in milliseconds. Drives the automatic status. */
  lastEventAt: number;
  /**
   * Silence duration in milliseconds after which an active run is marked
   * `quiet`. @default 15_000
   */
  quietAfterMs?: number;
  /** Silence duration in milliseconds after which an active run is marked `stalled`. @default 90_000 */
  stalledAfterMs?: number;
  /** Force a terminal state; skips silence thresholds and the live clock. */
  state?: "paused" | "done";
  /** Short description of the agent's current or most recent activity. */
  activity?: ReactNode;
  /** Recent activity samples, rendered as a compact bar chart. */
  pulses?: number[];
  /** Tick interval for the elapsed clock, in ms. @default 1000 */
  tickMs?: number;
  className?: string;
}

const STATE_COPY: Record<HeartbeatState, { label: string; badge: string }> = {
  live: { label: "Live", badge: "green" },
  quiet: { label: "Quiet", badge: "yellow" },
  stalled: { label: "Stalled", badge: "red" },
  paused: { label: "Paused", badge: "neutral" },
  done: { label: "Finished", badge: "neutral" },
};

const NO_PULSES: number[] = [];

function useNow(tickMs: number, enabled: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = enabled ? setInterval(() => setNow(Date.now()), tickMs) : undefined;
    return () => {
      if (id !== undefined) clearInterval(id);
    };
  }, [enabled, tickMs]);
  return now;
}

/**
 * Shows elapsed time and activity status for a long-running agent run.
 *
 * While no terminal `state` is provided, the component compares `lastEventAt`
 * with the current time and marks the run as `live`, `quiet`, or `stalled`.
 * Terminal states stop the clock and bypass those thresholds.
 */
export function AgentHeartbeat({
  startedAt,
  lastEventAt,
  quietAfterMs = 15_000,
  stalledAfterMs = 90_000,
  state,
  activity,
  pulses = NO_PULSES,
  tickMs = 1000,
  className,
}: AgentHeartbeatProps): ReactNode {
  const terminal = state != null;
  const now = useNow(tickMs, !terminal);
  const silentFor = Math.max(0, now - lastEventAt);

  let verdict: HeartbeatState = "live";
  if (terminal) {
    verdict = state;
  } else if (silentFor >= stalledAfterMs) {
    verdict = "stalled";
  } else if (silentFor >= quietAfterMs) {
    verdict = "quiet";
  }

  const copy = STATE_COPY[verdict];
  const status =
    verdict === "stalled"
      ? "failed"
      : verdict === "paused"
        ? "canceled"
        : verdict === "done"
          ? "completed"
          : "running";

  return (
    <div
      data-agent-heartbeat=""
      data-state={verdict}
      className={cn(
        "border-darker bg-default rounded-card-sm flex w-full min-w-0 items-center gap-3 border-[0.5px] px-3 py-2",
        verdict === "stalled" && "border-destructive",
        className,
      )}
    >
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex min-w-0 items-center gap-2">
          <span className="text-default text-sm font-medium">
            {formatDurationMs(now - startedAt)}
          </span>
          <Badge size="sm" shape="pill" variant={copy.badge as "green"}>
            {copy.label}
          </Badge>
        </span>
        <TypographySpan variant="muted" className="min-w-0 truncate text-xs">
          {activity ?? "—"}
          {verdict === "stalled" || verdict === "quiet" ? (
            <> · silent {formatDurationMs(silentFor)}</>
          ) : null}
        </TypographySpan>
      </span>

      {/* Recent beats: a coarse "has it been chatty or sluggish?" read that a
          single silence number can't give you. */}
      {pulses.length > 0 ? (
        <Sparkline
          values={pulses.slice(-24)}
          variant="bars"
          label="Recent agent activity"
          className="h-5 w-12"
        />
      ) : null}

      <AgentStatusIcon status={status} size="sm" className="shrink-0" />
    </div>
  );
}
