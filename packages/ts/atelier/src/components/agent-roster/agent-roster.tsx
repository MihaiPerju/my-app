"use client";

import { FaceAvatar } from "@mistralai/ui/face-avatar";
import { TypographySpan } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";
import type { CSSProperties, MouseEventHandler, ReactNode } from "react";
import { useCallback, useState } from "react";

import { formatDurationMs } from "../../lib/format";
import { STATUS_FILL } from "../../lib/status-colors";
import { useNow } from "../../lib/use-now";
import { AgentStatusIcon } from "../agent-status-icon/agent-status-icon";
import {
  AgentWorkProvider,
  AgentWorkSubtitle,
  AgentWorkSummary,
  AgentWorkTitle,
  AgentWorkTrailing,
} from "../agent-work/agent-work";
import type { AgentWorkStatus } from "../agent-work/agent-work";

interface Agent {
  id: string;
  name: string;
  status: AgentWorkStatus;
  activity: string;
  startedAt: number;
  endedAt?: number;
  step?: { index: number; total: number };
  note?: ReactNode;
}

const NOW = Date.now();
const ago = (seconds: number) => NOW - seconds * 1000;

const agents: Agent[] = [
  {
    id: "researcher",
    name: "researcher",
    status: "running",
    activity: "reading 12 sources on RAG evaluation",
    startedAt: ago(214),
    step: { index: 3, total: 5 },
    note: "18.2k tok",
  },
  {
    id: "sql-bot",
    name: "sql-bot",
    status: "running",
    activity: "EXPLAIN on warehouse.events",
    startedAt: ago(96),
    step: { index: 2, total: 4 },
    note: "4.1k tok",
  },
  {
    id: "code-reviewer",
    name: "code-reviewer",
    status: "blocked",
    activity: "waiting on approval: write to main",
    startedAt: ago(310),
    step: { index: 4, total: 6 },
  },
  {
    id: "triage-agent",
    name: "triage-agent",
    status: "completed",
    activity: "routed 41 tickets",
    startedAt: ago(420),
    endedAt: ago(96),
    step: { index: 6, total: 6 },
    note: "$0.031",
  },
  {
    id: "summarizer",
    name: "summarizer",
    status: "failed",
    activity: "context window exceeded (204k > 200k)",
    startedAt: ago(180),
    endedAt: ago(20),
  },
];

const progressStyles = agents.map<CSSProperties | null>((agent) => {
  if (agent.step == null || agent.step.total <= 0) return null;
  return { width: `${Math.min(1, agent.step.index / agent.step.total) * 100}%` };
});

export function AgentRoster(): ReactNode {
  const [selectedId, setSelectedId] = useState("sql-bot");
  const anyLive = agents.some((agent) => agent.endedAt == null && agent.status === "running");
  const now = useNow(1000, anyLive);
  const handleSelect = useCallback<MouseEventHandler<HTMLButtonElement>>((event) => {
    setSelectedId(event.currentTarget.value);
  }, []);

  return (
    <ul
      aria-label="Subagents"
      className="border-darker bg-default rounded-card-sm flex w-full min-w-0 list-none flex-col border-[0.5px]"
    >
      {agents.map((agent, index) => {
        const selected = agent.id === selectedId;
        const running = agent.status === "running";
        const progressStyle = progressStyles[index];

        return (
          <li
            key={agent.id}
            data-status={agent.status}
            data-selected={selected || undefined}
            className={cn(
              "relative",
              index > 0 && "border-darker border-t-[0.5px]",
              selected && "bg-basic-gray-alpha-4",
            )}
          >
            <AgentWorkProvider status={agent.status}>
              <button
                type="button"
                value={agent.id}
                aria-current={selected || undefined}
                className="hover:bg-basic-gray-alpha-2 focus-visible:ring-default grid w-full min-w-0 grid-cols-[minmax(0,1fr)_auto] px-3 py-2 text-start transition-colors focus-visible:outline-none focus-visible:ring-2"
                onClick={handleSelect}
              >
                <AgentWorkSummary className="gap-3">
                  <span className="relative shrink-0">
                    <FaceAvatar aria-hidden borderRadius={999} seed={agent.id} size={24} />
                    <span
                      aria-hidden
                      className={cn(
                        "border-default absolute -end-0.5 -bottom-0.5 size-2.5 rounded-full border-2",
                        STATUS_FILL[agent.status],
                      )}
                    />
                  </span>

                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="flex min-w-0 items-center gap-2">
                      <AgentWorkTitle>{agent.name}</AgentWorkTitle>
                      {agent.step == null ? null : (
                        <TypographySpan variant="subtle" className="shrink-0 text-xs tabular-nums">
                          {agent.step.index}/{agent.step.total}
                        </TypographySpan>
                      )}
                    </span>
                    <AgentWorkSubtitle
                      className={cn("text-default text-xs", running && "animate-shimmer-text")}
                    >
                      {agent.activity}
                    </AgentWorkSubtitle>
                  </span>
                </AgentWorkSummary>

                <AgentWorkTrailing>
                  {agent.note == null ? null : (
                    <TypographySpan variant="default" className="text-xs tabular-nums">
                      {agent.note}
                    </TypographySpan>
                  )}
                  <AgentElapsedTime endedAt={agent.endedAt} now={now} startedAt={agent.startedAt} />
                  <AgentStatusIcon size="sm" status={agent.status} />
                </AgentWorkTrailing>
              </button>
            </AgentWorkProvider>

            {progressStyle == null ? null : (
              <span
                aria-hidden
                style={progressStyle}
                className={cn(
                  "absolute bottom-0 start-0 h-px transition-[width] duration-500 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
                  STATUS_FILL[agent.status],
                )}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AgentElapsedTime({
  endedAt,
  now,
  startedAt,
}: {
  endedAt?: number;
  now: number;
  startedAt: number;
}): ReactNode {
  const elapsed = Math.max(0, (endedAt ?? now) - startedAt);

  return (
    <TypographySpan variant="default" className="w-14 text-end tabular-nums">
      {formatDurationMs(elapsed)}
    </TypographySpan>
  );
}
