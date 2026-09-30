import {
  toReviewListPage,
  type DocumentExtractionRequest,
  type DocumentReviewState,
  type DocumentReviewSubmission,
  type DocumentAnnotationUiApi,
  type DocumentAnnotationUiWorkflowInfo,
  type ReviewListPage,
  type ReviewListWirePage,
} from "@mistralai-capabilities/feature-document-annotation-ui";
import { unwrap } from "@/api/unwrap";

// The workflow catalog chooses the `route_segment` used by the shared Document Annotation UI execution contract.
// Review, document and image routes stay shared by execution id across the Document Annotation UI catalog.
import {
  documentAnnotationUiDocumentExtractionReviewDocument as getReviewDocumentRequest,
  documentAnnotationUiDocumentExtractionReviewImage as getReviewImageRequest,
  documentAnnotationUiDocumentExtractionReviewState as getReviewStateRequest,
  documentAnnotationUiDocumentExtractionSubmitReview as submitReviewRequest,
  documentAnnotationUiDocumentUpload as uploadDocumentRequest,
  documentAnnotationUiListSchemas as listSchemasRequest,
  documentAnnotationUiListWorkflows as listWorkflowsRequest,
} from "@/api/generated/sdk.gen";
import { client } from "@/api/generated/client.gen";

type WorkflowRoute = Pick<DocumentAnnotationUiWorkflowInfo, "route_segment">;
type StartResponse = { execution_id: string };
type ReviewAccepted = { message?: string | null };
type ListWorkflowExecutionsResponses = { 200: ReviewListWirePage };
type CreateWorkflowExecutionResponses = { 202: StartResponse };

const WORKFLOW_EXECUTIONS_URL = "/api/v1/document_annotation_ui/{route_segment}/executions";
const AUTH = [{ scheme: "bearer", type: "http" }] as const;

function listWorkflowExecutions(
  workflow: WorkflowRoute,
  nextPageToken?: string | null,
): Promise<ReviewListWirePage> {
  return unwrap(
    client.get<ListWorkflowExecutionsResponses, unknown, true>({
      path: { route_segment: workflow.route_segment },
      query: { next_page_token: nextPageToken },
      security: AUTH,
      throwOnError: true,
      url: WORKFLOW_EXECUTIONS_URL,
    }),
  );
}

function createWorkflowExecution(
  workflow: WorkflowRoute,
  request: DocumentExtractionRequest,
): Promise<StartResponse> {
  return unwrap(
    client.post<CreateWorkflowExecutionResponses, unknown, true>({
      body: request,
      path: { route_segment: workflow.route_segment },
      security: AUTH,
      throwOnError: true,
      url: WORKFLOW_EXECUTIONS_URL,
    }),
  );
}

async function listAllWorkflowExecutions(workflow: WorkflowRoute): Promise<ReviewListPage> {
  const pages: Array<ReviewListPage> = [];
  const seenTokens = new Set<string>();
  let nextPageToken: string | null | undefined = null;

  do {
    const page = toReviewListPage(await listWorkflowExecutions(workflow, nextPageToken));
    pages.push(page);
    nextPageToken = page.next_page_token;
    if (nextPageToken !== null && seenTokens.has(nextPageToken)) {
      throw new Error("Execution listing returned a repeated page token.");
    }
    if (nextPageToken !== null) {
      seenTokens.add(nextPageToken);
    }
  } while (nextPageToken !== null);

  return mergeReviewPages(pages);
}

function getReviewState(
  _workflow: WorkflowRoute,
  executionId: string,
): Promise<DocumentReviewState> {
  return unwrap(getReviewStateRequest({ path: { execution_id: executionId }, throwOnError: true }));
}

function getReviewDocument(_workflow: WorkflowRoute, executionId: string): Promise<Blob> {
  return unwrap(
    getReviewDocumentRequest({
      parseAs: "blob",
      path: { execution_id: executionId },
      throwOnError: true,
    }),
  );
}

function getReviewImage(
  _workflow: WorkflowRoute,
  executionId: string,
  imageId: string,
): Promise<Blob> {
  return unwrap(
    getReviewImageRequest({
      parseAs: "blob",
      path: { execution_id: executionId, image_id: imageId },
      throwOnError: true,
    }),
  );
}

function submitReview(
  _workflow: WorkflowRoute,
  executionId: string,
  body: DocumentReviewSubmission,
): Promise<ReviewAccepted> {
  return unwrap(
    submitReviewRequest({
      body,
      path: { execution_id: executionId },
      throwOnError: true,
    }),
  );
}

function mergeReviewPages(pages: Array<ReviewListPage>): ReviewListPage {
  return {
    executions: pages
      .flatMap((page) => page.executions)
      .toSorted((left, right) => {
        const leftTime = left.start_time ? Date.parse(left.start_time) : 0;
        const rightTime = right.start_time ? Date.parse(right.start_time) : 0;
        return rightTime - leftTime;
      }),
    next_page_token: null,
  };
}

export const documentAnnotationUiApi: DocumentAnnotationUiApi = {
  listWorkflows: () => unwrap(listWorkflowsRequest({ throwOnError: true })),

  listSchemas: () => unwrap(listSchemasRequest({ throwOnError: true })),

  listReviews: async () => {
    const workflows = await documentAnnotationUiApi.listWorkflows();
    const pages = await Promise.all(workflows.map(listAllWorkflowExecutions));
    return mergeReviewPages(pages);
  },

  // `openapi-ts` models the multipart body as the form object with its own serializer, so the
  // file goes in as `{ file }`. If codegen ever emits a raw-body signature, use `buildUploadFormData(file)`.
  uploadDocument: (file) => unwrap(uploadDocumentRequest({ body: { file }, throwOnError: true })),

  startExtraction: createWorkflowExecution,

  getReviewState,

  getReviewDocument,

  getReviewImage,

  submitReview,
};
