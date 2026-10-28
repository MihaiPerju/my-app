"use client";

import { Loader } from "@mistralai/ui/loader";
import { cn } from "@mistralai/ui/utils";
import {
  IconArrowRotateClockwise,
  IconBan,
  IconCircleCheck,
  IconCircleDotted,
  IconCircleXmark,
  IconTriangleWarning,
} from "nucleo-sharp";
import type { ReactNode } from "react";

import { CrossFade } from "../cross-fade/cross-fade";
import type { AgentStatus, AgentStatusIconProps } from "./types";

export type { AgentStatus, AgentStatusIconProps } from "./types";

/**
 * Accessible labels for each status, reusable across announcements,
 * tooltips, and legends.
 */
export const AGENT_STATUS_LABELS: Record<AgentStatus, string> = {
  pending: "Pending",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  canceled: "Canceled",
  blocked: "Blocked",
  retry: "Retrying",
};

const GLYPH_SIZE: Record<NonNullable<AgentStatusIconProps["size"]>, string> = {
  sm: "size-3.5",
  md: "size-4",
};

export function AgentStatusIcon({
  status,
  size = "md",
  label,
  showLabel = false,
  icon,
  className,
}: AgentStatusIconProps): ReactNode {
  const resolvedLabel = label ?? AGENT_STATUS_LABELS[status];
  const glyphSize = GLYPH_SIZE[size];

  return (
    <span data-status={status} className={cn("inline-flex items-center gap-1.5", className)}>
      <CrossFade token={icon === undefined ? status : "custom"} className={glyphSize}>
        {icon ?? <StatusGlyph status={status} glyphSize={glyphSize} />}
      </CrossFade>
      {showLabel ? (
        <span className="text-default text-sm">{resolvedLabel}</span>
      ) : (
        <span className="sr-only">{resolvedLabel}</span>
      )}
    </span>
  );
}

function StatusGlyph({ status, glyphSize }: { status: AgentStatus; glyphSize: string }): ReactNode {
  switch (status) {
    case "running":
      return (
        <Loader aria-hidden className={glyphSize} role="presentation" size="sm" variant="default" />
      );
    case "completed":
      return <IconCircleCheck aria-hidden className={cn("text-icon-success", glyphSize)} />;
    case "failed":
      return <IconTriangleWarning aria-hidden className={cn("text-icon-destructive", glyphSize)} />;
    case "canceled":
      return (
        <IconBan aria-hidden className={cn("text-icon-default-muted opacity-60", glyphSize)} />
      );
    case "retry":
      return (
        <IconArrowRotateClockwise
          aria-hidden
          className={cn("text-icon-default-muted", glyphSize)}
        />
      );
    case "blocked":
      return <IconCircleXmark aria-hidden className={cn("text-icon-default-muted", glyphSize)} />;
    case "pending":
    default:
      return (
        <IconCircleDotted
          aria-hidden
          className={cn("text-icon-default-muted opacity-60", glyphSize)}
        />
      );
  }
}
