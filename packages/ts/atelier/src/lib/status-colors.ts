import type { AgentStatus } from "../components/agent-status-icon/types";

export const STATUS_FILL = {
  pending: "bg-basic-gray-alpha-10",
  running: "bg-(--icon-default)",
  completed: "bg-(--icon-success)",
  failed: "bg-(--icon-destructive)",
  canceled: "bg-basic-gray-alpha-10",
  blocked: "bg-(--icon-default-muted)",
  retry: "bg-(--icon-default-muted)",
} satisfies Record<AgentStatus, string>;

export const STATUS_ORDER: AgentStatus[] = [
  "failed",
  "blocked",
  "retry",
  "running",
  "pending",
  "completed",
  "canceled",
];

export function tallyByStatus(
  agents: { status: AgentStatus }[],
): { status: AgentStatus; count: number }[] {
  return STATUS_ORDER.flatMap((status) => {
    const count = agents.filter((agent) => agent.status === status).length;
    return count === 0 ? [] : [{ status, count }];
  });
}
