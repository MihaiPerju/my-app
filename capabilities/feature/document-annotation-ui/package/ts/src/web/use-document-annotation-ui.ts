import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import type { DocumentAnnotationUiApi } from "../api";
import { isTerminalRunStatus, REVIEW_POLL_INTERVAL_MS } from "../lib";
import type {
  DocumentExtractionRequest,
  DocumentReviewState,
  DocumentReviewSubmission,
  DocumentAnnotationUiWorkflowInfo,
} from "../types";

/**
 * A supertype of react-query's `Query`, covering only what the poll decision reads.
 *
 * Structural rather than `import type { Query }`: react-query is an optional peer, so importing its
 * types is another way a consumer's install layout can break the build. A supertype keeps
 * `refetchInterval` assignable (parameters are contravariant).
 */
type ReviewStateQuerySnapshot = { state: { data?: DocumentReviewState | undefined } };
type WorkflowRoute = Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;

function requireWorkflow(workflow: WorkflowRoute): Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> {
  if (workflow === null) {
    throw new Error("workflow is required");
  }
  return workflow;
}

function routeKey(workflow: WorkflowRoute): string {
  return workflow?.route_segment ?? "none";
}

/** Exported so the page can invalidate the listing after a decision without restating the key. */
export const REVIEWS_QUERY_KEY = ["document-annotation-ui", "reviews"] as const;

export const WORKFLOWS_QUERY_KEY = ["document-annotation-ui", "workflows"] as const;

export const SCHEMAS_QUERY_KEY = ["document-annotation-ui", "schemas"] as const;

/** `staleTime: Infinity` because the catalog is compiled in: it cannot change within a session. */
export function useWorkflowsQuery(api: DocumentAnnotationUiApi) {
  return useQuery({
    queryKey: WORKFLOWS_QUERY_KEY,
    queryFn: () => api.listWorkflows(),
    staleTime: Infinity,
  });
}

/** Same reasoning as the catalog: the document-type registry is compiled in, so it cannot go stale. */
export function useSchemasQuery(api: DocumentAnnotationUiApi) {
  return useQuery({
    queryKey: SCHEMAS_QUERY_KEY,
    queryFn: () => api.listSchemas(),
    staleTime: Infinity,
  });
}

/**
 * Unpolled, unlike the review state: the list is the screen a reviewer LEAVES to open a run, so
 * the only status change it can miss is one they caused themselves — which
 * `useInvalidateReviewsList` covers on the way back.
 */
export function useReviewsListQuery(api: DocumentAnnotationUiApi) {
  return useQuery({
    queryKey: REVIEWS_QUERY_KEY,
    queryFn: () => api.listReviews(),
  });
}

export function useInvalidateReviewsList() {
  const queryClient = useQueryClient();
  return () => {
    void queryClient.invalidateQueries({ queryKey: REVIEWS_QUERY_KEY });
  };
}

export function useUploadDocumentMutation(api: DocumentAnnotationUiApi) {
  return useMutation({
    mutationFn: (file: File) => api.uploadDocument(file),
  });
}

export function useStartExtractionMutation(api: DocumentAnnotationUiApi, workflow: WorkflowRoute) {
  return useMutation({
    mutationFn: (body: DocumentExtractionRequest) =>
      api.startExtraction(requireWorkflow(workflow), body),
  });
}

export function useSubmitReviewMutation(api: DocumentAnnotationUiApi, workflow: WorkflowRoute) {
  return useMutation({
    mutationFn: ({
      executionId,
      body,
    }: {
      executionId: string;
      body: DocumentReviewSubmission;
    }) => api.submitReview(requireWorkflow(workflow), executionId, body),
  });
}

/**
 * The run's stored document, for a review being reopened.
 *
 * The upload path already holds the bytes, so the caller passes `null` and this query stays off.
 * `staleTime: Infinity` because a run's document cannot change. `retry: false` because the failures
 * worth reporting (no document, storage unreachable) are answers, not blips.
 */
export function useReviewDocumentQuery(
  api: DocumentAnnotationUiApi,
  workflow: WorkflowRoute,
  executionId: string | null,
) {
  return useQuery({
    queryKey: ["document-annotation-ui", "document", routeKey(workflow), "content", executionId],
    queryFn: () => {
      if (executionId === null) {
        throw new Error("executionId is required");
      }
      return api.getReviewDocument(requireWorkflow(workflow), executionId);
    },
    enabled: executionId !== null && workflow !== null,
    staleTime: Infinity,
    retry: false,
  });
}


/**
 * One OCR page image, fetched on demand from object storage rather than carried in review state.
 *
 * Same rationale as the document query: the bytes are pinned to the run (key minted per upload),
 * so ``staleTime: Infinity`` and ``retry: false`` — a missing image is an answer, not a blip.
 */
export function useReviewImageQuery(
  api: DocumentAnnotationUiApi,
  workflow: WorkflowRoute,
  executionId: string | null,
  imageId: string | null,
) {
  return useQuery({
    queryKey: ["document-annotation-ui", "document", routeKey(workflow), "image", executionId, imageId],
    queryFn: () => {
      if (executionId === null || imageId === null) {
        throw new Error("executionId and imageId are required");
      }
      return api.getReviewImage(requireWorkflow(workflow), executionId, imageId);
    },
    enabled: executionId !== null && imageId !== null && workflow !== null,
    staleTime: Infinity,
    retry: false,
  });
}

/**
 * Poll the review state of a run until it settles.
 *
 * Disabled until an execution id exists, and stops refetching once the run reaches a terminal
 * status — `pending_review` keeps polling so a human decision is picked up.
 */
export function useReviewStateQuery(
  api: DocumentAnnotationUiApi,
  workflow: WorkflowRoute,
  executionId: string | null,
) {
  return useQuery({
    queryKey: ["document-annotation-ui", "document", routeKey(workflow), "review-state", executionId],
    queryFn: () => {
      if (executionId === null) {
        throw new Error("executionId is required");
      }
      return api.getReviewState(requireWorkflow(workflow), executionId);
    },
    enabled: executionId !== null && workflow !== null,
    refetchInterval: (query: ReviewStateQuerySnapshot) => {
      const status = query.state.data?.status;
      if (status !== undefined && isTerminalRunStatus(status)) {
        return false;
      }
      return REVIEW_POLL_INTERVAL_MS;
    },
  });
}
