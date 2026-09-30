import type {
  DocumentExtractionRequest,
  DocumentReviewState,
  DocumentReviewSubmission,
  DocumentAnnotationUiSchemasResponse,
  DocumentAnnotationUiWorkflowInfo,
  ReviewListPage,
  UploadResult,
} from "./types";

type WorkflowRoute = Pick<DocumentAnnotationUiWorkflowInfo, "route_segment">;

/**
 * The Document Annotation UI API interface the app binds its generated client to.
 *
 * Pure interface, no implementation: the template feature layer injects a concrete instance, so
 * this package never depends on a transport or on the generated client.
 */
export interface DocumentAnnotationUiApi {
  /** The workflow catalog — the enumeration the core `WorkflowRouter` cannot give us. */
  listWorkflows(): Promise<Array<DocumentAnnotationUiWorkflowInfo>>;
  /** The document-type registry a run names through `schema_name`, plus the default system prompt. */
  listSchemas(): Promise<DocumentAnnotationUiSchemasResponse>;
  /** The caller's Document Annotation UI runs across catalog workflows. The platform scopes each listing server-side. */
  listReviews(): Promise<ReviewListPage>;
  uploadDocument(file: File): Promise<UploadResult>;
  startExtraction(
    workflow: WorkflowRoute,
    request: DocumentExtractionRequest,
  ): Promise<{ execution_id: string }>;
  getReviewState(workflow: WorkflowRoute, executionId: string): Promise<DocumentReviewState>;
  /**
   * The run's document, as stored — the reopen path.
   *
   * Takes the EXECUTION id and nothing else: the storage key is the server's to derive, so a
   * caller cannot name the object it gets back. Rejects when the run holds no document (404) or
   * object storage is unreachable (503).
   */
  getReviewDocument(workflow: WorkflowRoute, executionId: string): Promise<Blob>;
  /**
   * One OCR page image, as stored — same server-derived-key, ownership-checked contract as
   * {@link getReviewDocument}, addressed by the run and the image id from `OcrPageResult.image_ids`.
   */
  getReviewImage(
    workflow: WorkflowRoute,
    executionId: string,
    imageId: string,
  ): Promise<Blob>;
  submitReview(
    workflow: WorkflowRoute,
    executionId: string,
    body: DocumentReviewSubmission,
  ): Promise<{ message?: string | null }>;
}
