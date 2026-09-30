import { useQueries } from "@tanstack/react-query";
import {
  REVIEW_POLL_INTERVAL_MS,
  isTerminalRunStatus,
  normalizeExecutionStatus,
  type DocumentAnnotationUiWorkflowInfo,
  type ReviewListItem,
  type ReviewListPage,
  type WorkflowRunStatus,
} from "@mistralai-capabilities/feature-document-annotation-ui";
import {
  useReviewDocumentQuery as useReviewDocumentQueryBase,
  useReviewImageQuery as useReviewImageQueryBase,
  useReviewsListQuery as useReviewsListQueryBase,
  useReviewStateQuery as useReviewStateQueryBase,
  useSchemasQuery as useSchemasQueryBase,
  useStartExtractionMutation as useStartExtractionMutationBase,
  useSubmitReviewMutation as useSubmitReviewMutationBase,
  useUploadDocumentMutation as useUploadDocumentMutationBase,
  useWorkflowsQuery as useWorkflowsQueryBase,
} from "@mistralai-capabilities/feature-document-annotation-ui/web";

import { documentAnnotationUiApi } from "./api";

export { useInvalidateReviewsList } from "@mistralai-capabilities/feature-document-annotation-ui/web";

type WorkflowRoute = Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;

export function useUploadDocumentMutation() {
  return useUploadDocumentMutationBase(documentAnnotationUiApi);
}

export function useStartExtractionMutation(workflow: WorkflowRoute) {
  return useStartExtractionMutationBase(documentAnnotationUiApi, workflow);
}

export function useSubmitReviewMutation(workflow: WorkflowRoute) {
  return useSubmitReviewMutationBase(documentAnnotationUiApi, workflow);
}

export function useReviewStateQuery(workflow: WorkflowRoute, executionId: string | null) {
  return useReviewStateQueryBase(documentAnnotationUiApi, workflow, executionId);
}

// A function param typed as a structural SUPERTYPE of react-query's `Query` stays assignable to
// `refetchInterval` (params are contravariant); we only read the cached status.
type ReviewStateSnapshot = { state: { data?: { status?: WorkflowRunStatus } } };

/**
 * The reviews list, enriched with each run's REVIEW status in a column distinct from the platform
 * `status`. A decided run shows Approved/Rejected from its persisted `review_decision` with no
 * query. Only a still-running row fetches its review state to surface `pending_review`.
 */
export function useReviewsListQuery() {
  const base = useReviewsListQueryBase(documentAnnotationUiApi);
  const workflowsQuery = useWorkflowsQueryBase(documentAnnotationUiApi);
  const executions = base.data?.executions ?? [];
  const workflows = workflowsQuery.data ?? [];
  const defaultWorkflow = workflows[0] ?? null;
  const routeByName = new Map(workflows.map((workflow) => [workflow.name, workflow]));

  const workflowFor = (execution: ReviewListItem): WorkflowRoute =>
    (execution.workflow_name ? routeByName.get(execution.workflow_name) : undefined) ??
    defaultWorkflow;

  // The Review column value per run. A persisted decision shows instantly, with no extra query.
  type ReviewStatus = NonNullable<ReviewListItem["review_status"]>;
  const reviews = new Map<string, ReviewStatus>();
  for (const execution of executions) {
    const decision = execution.review_decision;
    if (decision === "approved" || decision === "rejected")
      reviews.set(execution.execution_id, decision);
  }

  // Only a still-running, undecided run needs a review-state fetch — to tell a run waiting at the
  // human-review gate (`pending_review`) from one that is merely still working.
  const gateIds = executions
    .filter(
      (execution) =>
        !reviews.has(execution.execution_id) &&
        normalizeExecutionStatus(execution.status) === "running",
    )
    .map((execution) => ({
      executionId: execution.execution_id,
      workflow: workflowFor(execution),
    }));

  const stateQueries = useQueries({
    queries: gateIds.map(({ executionId, workflow }) => ({
      queryKey: [
        "document-annotation-ui",
        "document",
        workflow?.route_segment ?? "none",
        "review-state",
        executionId,
      ] as const,
      queryFn: () => {
        if (workflow === null) {
          throw new Error("workflow is required");
        }
        return documentAnnotationUiApi.getReviewState(workflow, executionId);
      },
      enabled: workflow !== null,
      staleTime: REVIEW_POLL_INTERVAL_MS,
      // Keep the Review column live while a run sits at the gate; stop once it is terminal.
      refetchInterval: (query: ReviewStateSnapshot) => {
        const status = query.state.data?.status;
        return status !== undefined && isTerminalRunStatus(status)
          ? false
          : REVIEW_POLL_INTERVAL_MS;
      },
    })),
  });

  gateIds.forEach(({ executionId }, index) => {
    if (stateQueries[index]?.data?.status === "pending_review") {
      reviews.set(executionId, "pending_review");
    }
  });

  if (reviews.size === 0) return base;

  const data: ReviewListPage | undefined = base.data
    ? {
        ...base.data,
        executions: executions.map((execution) => {
          const review_status = reviews.get(execution.execution_id);
          return review_status === undefined
            ? execution
            : Object.assign({}, execution, { review_status });
        }),
      }
    : base.data;

  return { ...base, data };
}

export function useReviewDocumentQuery(workflow: WorkflowRoute, executionId: string | null) {
  return useReviewDocumentQueryBase(documentAnnotationUiApi, workflow, executionId);
}

export function useReviewImageQuery(
  workflow: WorkflowRoute,
  executionId: string | null,
  imageId: string | null,
) {
  return useReviewImageQueryBase(documentAnnotationUiApi, workflow, executionId, imageId);
}

export function useWorkflowsQuery() {
  return useWorkflowsQueryBase(documentAnnotationUiApi);
}

export function useSchemasQuery() {
  return useSchemasQueryBase(documentAnnotationUiApi);
}
