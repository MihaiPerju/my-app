/**
 * One run's status, as a badge.
 *
 * Its own module because both shapes of the route need it: the list to say how each run ended, and
 * the review screen's top bar to say how the open one is going. The list is rendered by the page,
 * so keeping the badge on the page would make an import cycle.
 */

import { Badge, BadgeIcon } from "@mistralai/ui/badge";
import {
  ArrowClockwiseIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  ClockIcon,
  type Icon,
  XCircleIcon,
  XIcon,
} from "@phosphor-icons/react";

import {
  normalizeExecutionStatus,
  type RunDisplayStatus,
} from "@mistralai-capabilities/feature-document-annotation-ui";

type BadgeVariant = "blue" | "green" | "neutral" | "orange" | "orangebright" | "red" | "yellow";
type StatusMeta = {
  label: string;
  variant: BadgeVariant;
  icon: Icon;
  /** Set on the two statuses that mean "still moving", which is what the original spun. */
  spins?: true;
};

const STATUS_META = {
  running: { label: "Running", variant: "blue", icon: CircleNotchIcon, spins: true },
  pending_review: { label: "Awaiting review", variant: "orange", icon: ClockIcon },
  completed: { label: "Completed", variant: "green", icon: CheckCircleIcon },
  approved: { label: "Approved", variant: "green", icon: CheckCircleIcon },
  rejected: { label: "Rejected", variant: "orange", icon: XCircleIcon },
  failed: { label: "Failed", variant: "red", icon: XCircleIcon },
  retried: { label: "Retrying", variant: "yellow", icon: ArrowClockwiseIcon },
  cancelling: { label: "Cancelling", variant: "orangebright", icon: CircleNotchIcon, spins: true },
  cancelled: { label: "Cancelled", variant: "neutral", icon: XIcon },
} as const satisfies Record<RunDisplayStatus, StatusMeta>;

// `status` arrives from two vocabularies and may be neither, so membership in the table is checked
// before indexing. The table's keys are exactly `RunDisplayStatus` (enforced by the `satisfies`
// above), so an `in` hit soundly narrows the key — no assertion or index-signature widening needed.
function isRunDisplayStatus(value: string): value is RunDisplayStatus {
  return value in STATUS_META;
}

/** `CONTINUED_AS_NEW` -> `Continued as new`: readable, without pretending we know what it means. */
function humanize(status: string): string {
  const spaced = status.replaceAll("_", " ").toLowerCase();
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

/**
 * Accepts both vocabularies: a `WorkflowRunStatus` from the review state and the platform's
 * `RUNNING`-style status from the listing, since `normalizeExecutionStatus` passes the first
 * through untouched. An unclaimed status still renders neutral and spelled out, so a run is never
 * a blank cell.
 */
export function RunStatusBadge({ status }: { status: string | null | undefined }) {
  // A run-vocabulary value (approved/rejected/pending_review, e.g. from `review_status`) is already a
  // badge key; the platform's `RUNNING`-style listing status is normalized into one below.
  const direct = status != null && isRunDisplayStatus(status) ? STATUS_META[status] : undefined;
  const normalized = normalizeExecutionStatus(status);
  const meta: StatusMeta | undefined = direct ?? (normalized ? STATUS_META[normalized] : undefined);

  if (!meta) {
    return (
      <Badge bordered size="sm" variant="neutral">
        {status ? humanize(status) : "Unknown"}
      </Badge>
    );
  }

  return (
    <Badge bordered size="sm" variant={meta.variant}>
      <BadgeIcon className={meta.spins ? "animate-spin" : undefined} icon={meta.icon} />
      {meta.label}
    </Badge>
  );
}
