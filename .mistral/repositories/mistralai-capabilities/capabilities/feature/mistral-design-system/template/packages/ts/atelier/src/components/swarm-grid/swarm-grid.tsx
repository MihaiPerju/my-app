"use client";

import { TypographySpan } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";
import type { CSSProperties, ReactNode } from "react";
import { useMemo } from "react";

import { STATUS_FILL, STATUS_ORDER, tallyByStatus } from "../../lib/status-colors";
import { AGENT_STATUS_LABELS } from "../agent-status-icon/agent-status-icon";
import type { SwarmGridProps } from "./types";

export type { SwarmAgent, SwarmGridProps } from "./types";

/** Compact status overview for monitoring a large agent fleet. */
export function SwarmGrid({
  agents,
  order = "index",
  cell = 12,
  isLegendVisible = true,
  isSummaryVisible = true,
  selectedId,
  onSelect,
  label = "Agent fleet",
  className,
}: SwarmGridProps): ReactNode {
  const tally = useMemo(() => tallyByStatus(agents), [agents]);

  const ordered = useMemo(() => {
    if (order === "index") return agents;
    const rank = new Map(STATUS_ORDER.map((status, index) => [status, index]));
    // Stable sort: within a status group, dispatch order is preserved, so the
    // grouped view still reads left-to-right as "who started first".
    return [...agents].sort((a, b) => (rank.get(a.status) ?? 99) - (rank.get(b.status) ?? 99));
  }, [agents, order]);

  const total = agents.length;
  const cellStyle = useMemo<CSSProperties>(() => ({ width: cell, height: cell }), [cell]);

  return (
    <div className={cn("flex w-full min-w-0 flex-col gap-2", className)}>
      {isSummaryVisible && total > 0 ? (
        <div
          aria-hidden
          className="bg-basic-gray-alpha-6 flex h-1.5 w-full overflow-hidden rounded-full"
        >
          {tally.map(({ status, count }) => (
            <span
              key={status}
              // oxlint-disable-next-line react-perf/jsx-no-new-object-as-prop
              style={{ width: `${(count / total) * 100}%` }}
              className={cn("h-full", STATUS_FILL[status])}
            />
          ))}
        </div>
      ) : null}

      {isLegendVisible ? (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {tally.map(({ status, count }) => (
            <span key={status} className="flex items-center gap-1.5">
              <span aria-hidden className={cn("size-2 shrink-0 rounded-2", STATUS_FILL[status])} />
              <TypographySpan variant="muted" className="text-xs tabular-nums">
                {count} {AGENT_STATUS_LABELS[status].toLowerCase()}
              </TypographySpan>
            </span>
          ))}
          <TypographySpan variant="subtle" className="ms-auto text-xs tabular-nums">
            {total} agents
          </TypographySpan>
        </div>
      ) : null}

      <ul aria-label={label} className="flex flex-wrap gap-1">
        {ordered.map((agent) => {
          const selected = agent.id === selectedId;
          const title = agent.detail
            ? `${agent.name} — ${AGENT_STATUS_LABELS[agent.status]} · ${agent.detail}`
            : `${agent.name} — ${AGENT_STATUS_LABELS[agent.status]}`;

          return (
            <li key={agent.id} className="flex">
              <button
                type="button"
                aria-label={title}
                aria-current={selected || undefined}
                data-status={agent.status}
                disabled={onSelect == null}
                style={cellStyle}
                className={cn(
                  "rounded-2 transition-transform",
                  STATUS_FILL[agent.status],
                  agent.status === "running" && "motion-safe:animate-pulse",
                  onSelect != null &&
                    "focus-visible:ring-default hover:scale-125 focus-visible:outline-none focus-visible:ring-2 motion-reduce:hover:scale-100",
                  selected && "ring-default scale-125 ring-2",
                )}
                // oxlint-disable-next-line react-perf/jsx-no-new-function-as-prop
                onClick={() => onSelect?.(agent)}
              />
            </li>
          );
        })}
      </ul>
    </div>
  );
}
