import type { ReactElement } from "react";

/** Lifecycle status for an agent or step. */
export type AgentStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "canceled"
  | "blocked"
  | "retry";

export interface AgentStatusIconProps {
  /** Status represented by the icon and optional label. */
  status: AgentStatus;
  /** @default "md" */
  size?: "sm" | "md";
  /** Override the accessible label; defaults to `AGENT_STATUS_LABELS[status]`. */
  label?: string;
  /** @default false */
  showLabel?: boolean;
  /** Custom glyph. Omit or pass `null` to use the default status glyph. */
  icon?: ReactElement | null;
  className?: string;
}
