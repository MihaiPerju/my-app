import type { AgentStatus } from "../agent-status-icon/types";

export interface SwarmAgent {
  id: string;
  name: string;
  status: AgentStatus;
  /** Optional one-line detail surfaced on hover/focus. */
  detail?: string;
}

export interface SwarmGridProps {
  agents: SwarmAgent[];
  /**
   * `index` keeps dispatch order while `status` groups the fleet. @default
   * "index"
   */
  order?: "index" | "status";
  /** Cell edge length in px. Shrink it as the fleet grows. @default 12 */
  cell?: number;
  /** Show the counts legend above the grid. @default true */
  isLegendVisible?: boolean;
  /** Show the stacked proportion bar above the grid. @default true */
  isSummaryVisible?: boolean;
  selectedId?: string;
  onSelect?: (agent: SwarmAgent) => void;
  /** Accessible name. @default "Agent fleet" */
  label?: string;
  className?: string;
}
