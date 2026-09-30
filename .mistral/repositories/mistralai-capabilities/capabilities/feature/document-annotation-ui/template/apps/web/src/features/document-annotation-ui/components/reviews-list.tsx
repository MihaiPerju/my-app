/**
 * The first of the route's three shapes: the runs this user has started.
 *
 * A port of the original's processing table, minus the columns this capability cannot fill. The
 * platform listing knows a run exists, how it ended and how long it took, but not the document name
 * or whether review is still needed, because those live in the run's review state. So the Document
 * column is absent; a row shows what the listing knows and opening one fetches the rest.
 */

import { Button, ButtonLeadIcon } from "@mistralai/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@mistralai/ui/table";
import { TypographySpan } from "@mistralai/ui/typography";
import { CopyIcon, PlusIcon, StackIcon } from "@phosphor-icons/react";

import {
  formatRunDuration,
  shortExecutionId,
  type ReviewListItem,
} from "@mistralai-capabilities/feature-document-annotation-ui";
import {
  EmptyState,
  ErrorState,
  LoadingState,
  ProductSection,
} from "@mistralai-capabilities/feature-mistral-design-system/components";
import { formatMessageDate } from "@mistralai-capabilities/feature-mistral-design-system/lib";

import { useReviewsListQuery } from "../use-document-annotation-ui";
import { RunStatusBadge } from "./run-status-badge";

const LIST_DESCRIPTION =
  "Every extraction run you have started. Open one to check its fields against the document it came from, or start a new one.";

const ABSENT = "—";

/** `formatMessageDate` answers `""` for a value that is not a date; a column wants a dash. */
function formatTimestamp(value: string | null | undefined): string {
  if (!value) return ABSENT;
  return formatMessageDate(value, { format: "long" }) || ABSENT;
}

function CopyIdButton({ executionId }: { executionId: string }) {
  return (
    <Button
      className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100"
      icon={CopyIcon}
      mode="icon-only"
      onClick={(event) => {
        event.stopPropagation();
        void navigator.clipboard.writeText(executionId);
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") event.stopPropagation();
      }}
      size="xs"
      title="Copy run id"
      type="button"
      variant="ghost"
    />
  );
}

/**
 * The whole row is the click target, as it was in the original.
 *
 * A `<tr>` takes no keyboard focus, so the row carries the button role and the Enter and Space
 * handling a real button gives. Without it, a run is reachable only by mouse.
 */
function ReviewRow({
  review,
  onOpen,
}: {
  review: ReviewListItem;
  onOpen: (executionId: string, workflowName: string | null) => void;
}) {
  const open = () => onOpen(review.execution_id, review.workflow_name ?? null);

  return (
    <TableRow
      className="group cursor-pointer"
      onClick={open}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        open();
      }}
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- a <tr> cannot be a <button>; the row keeps explicit tabIndex + Enter/Space handling
      role="button"
      tabIndex={0}
    >
      <TableCell className="px-4 py-3.5">
        <div className="flex items-center gap-2">
          <CopyIdButton executionId={review.execution_id} />
          <TypographySpan className="font-mono" size="sm">
            …{shortExecutionId(review.execution_id)}
          </TypographySpan>
        </div>
      </TableCell>
      <TableCell className="px-4 py-3.5">
        <RunStatusBadge status={review.status} />
      </TableCell>
      <TableCell className="px-4 py-3.5">
        {review.review_status ? (
          <RunStatusBadge status={review.review_status} />
        ) : (
          <TypographySpan className="text-subtle" size="sm">
            {ABSENT}
          </TypographySpan>
        )}
      </TableCell>
      <TableCell className="text-subtle px-4 py-3.5 text-sm">
        {formatTimestamp(review.start_time)}
      </TableCell>
      <TableCell className="text-subtle px-4 py-3.5 text-sm">
        {formatTimestamp(review.end_time)}
      </TableCell>
      <TableCell className="text-subtle px-4 py-3.5 text-sm">
        {formatRunDuration(review.total_duration_ms)}
      </TableCell>
    </TableRow>
  );
}

export type ReviewsListProps = {
  onNew: () => void;
  onOpen: (executionId: string, workflowName: string | null) => void;
};

export function ReviewsList({ onNew, onOpen }: ReviewsListProps) {
  const reviewsQuery = useReviewsListQuery();
  const reviews: ReadonlyArray<ReviewListItem> = reviewsQuery.data?.executions ?? [];

  if (reviewsQuery.error) {
    return (
      <ProductSection title="Reviews">
        <ErrorState error={reviewsQuery.error} title="Could not load your reviews" />
      </ProductSection>
    );
  }

  if (reviewsQuery.isPending) {
    return (
      <ProductSection title="Reviews">
        <LoadingState description="Fetching the runs you have started." title="Loading reviews" />
      </ProductSection>
    );
  }

  if (reviews.length === 0) {
    return (
      <ProductSection description={LIST_DESCRIPTION} title="Reviews">
        <EmptyState
          action={
            <Button onClick={onNew} size="sm" type="button" variant="ghost">
              <ButtonLeadIcon icon={PlusIcon} />
              Start a new one
            </Button>
          }
          description="Upload a document and a schema, and the run will show up here."
          icon={<StackIcon aria-hidden className="size-8" />}
          title="No reviews yet — start one."
        />
      </ProductSection>
    );
  }

  return (
    <ProductSection description={LIST_DESCRIPTION} title="Reviews">
      <Table>
        <TableHeader>
          <TableRow className="text-subtle">
            <TableHead className="px-4 py-3">Run</TableHead>
            <TableHead className="px-4 py-3">Workflow status</TableHead>
            <TableHead className="px-4 py-3">Review status</TableHead>
            <TableHead className="px-4 py-3">Started</TableHead>
            <TableHead className="px-4 py-3">Completed</TableHead>
            <TableHead className="px-4 py-3">Duration</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {reviews.map((review) => (
            <ReviewRow key={review.execution_id} onOpen={onOpen} review={review} />
          ))}
        </TableBody>
      </Table>
    </ProductSection>
  );
}
