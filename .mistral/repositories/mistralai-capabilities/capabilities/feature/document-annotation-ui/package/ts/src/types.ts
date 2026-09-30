/**
 * Mirror types for the Document Annotation UI loop-boundary contract.
 *
 * Hand-kept structural mirrors of the Python schemas in
 * `package/py/src/mistralai_capabilities/document_annotation_ui/schemas.py`. Field names are the wire names:
 * `ExtractedDocument` carries `_sources` (the Pydantic alias), not `sources`. The contract-parity
 * type test that pins these to the generated OpenAPI types lands with the E2E wave.
 */

export type WorkflowRunStatus =
  | "running"
  | "pending_review"
  | "completed"
  | "rejected"
  | "failed"
  | "retried"
  | "cancelling"
  | "cancelled";

/** How a human reviewer decided a run. Mirrors the OpenAPI `ReviewDecision`. */
export type ReviewDecision = "approved" | "rejected";

/**
 * What the run badge and status callout render: a run status, or — for a decided run, which reads
 * `completed`/`rejected` at the platform level — the review decision it carries. Web-only; the wire
 * never sends this union, so it is not parity-checked.
 */
export type RunDisplayStatus = WorkflowRunStatus | ReviewDecision;

/**
 * One workflow this capability contributes, as declared in `workflows_catalog.py`.
 *
 * `WorkflowRouter` can route a workflow class but cannot enumerate the ones a capability ships, so
 * the catalog exists and arrives over its own route. `review_step` is the step the run pauses on,
 * or null when it never pauses. `show_debug` gates the review screen's Debug tab.
 */
export type DocumentAnnotationUiWorkflowInfo = {
  name: string;
  display_name: string;
  description: string;
  review_step: string | null;
  show_debug: boolean;
  route_segment: string;
};

export type ReviewSignal = {
  step: string;
  decision: ReviewDecision;
  reviewed_output?: Record<string, unknown> | null;
  note?: string | null;
  reviewed_by?: string | null;
};

export type OcrBlockResult = {
  content: string;
  type: string;
  top_left_x: number;
  top_left_y: number;
  bottom_right_x: number;
  bottom_right_y: number;
};

export type OcrPageResult = {
  index: number;
  width: number;
  height: number;
  blocks: Array<OcrBlockResult>;
  /** OCR image ids for this page, in order; fetch each via the review-image route by its id. */
  image_ids?: Array<string>;
};

export type OcrDocumentResult = {
  ocr_text: string;
  page_count: number;
  page_confidences?: Array<number> | null;
  pages?: Array<OcrPageResult>;
};

export type ExtractedDocument = {
  data?: Record<string, unknown>;
  _sources?: Record<string, Array<string>>;
};

/** One field the resolved schema rejected, addressed by its dot-notated path into the extraction. */
export type SchemaFieldError = {
  path: string;
  message: string;
};

export type DocumentTypeInfo = {
  name: string;
  display_name: string;
  // The resolved JSON Schema the run extracts against, so the form can show it read-only on
  // selection. Opaque object here — the panel stringifies it for display, never interprets it.
  json_schema: Record<string, unknown>;
};

/**
 * The document-type registry, plus the multi-line system prompt a run applies when it carries no
 * `prompt` of its own — on the wire so the debug affordance can show the real starting text rather
 * than an empty box that silently means "the default".
 */
export type DocumentAnnotationUiSchemasResponse = {
  document_types: Array<DocumentTypeInfo>;
  default_prompt: string;
};

/** A run request naming the registered document type to extract. */
export type DocumentExtractionRequest = {
  /** Object-storage key from `uploadDocument`. */
  document_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  schema_name: string;
  prompt?: string | null;
};

/** What `POST /v1/document_annotation_ui/upload` returns once the document is in object storage. */
export type UploadResult = {
  document_key: string;
  file_name: string;
  mime_type: string;
  size: number;
};

export type DocumentExtractionResponse = {
  status: string;
  decision?: string | null;
  extracted?: ExtractedDocument | null;
};

/**
 * A run's review state, including where its document still lives.
 *
 * `document_key` makes a review reopenable. The client does not read it as a key; the content
 * route derives its own copy server-side. Its presence signals that the run has a document to
 * fetch, which tells "reopened, get the bytes" apart from "nothing stored, use the OCR rasters".
 */
export type DocumentReviewState = {
  status: WorkflowRunStatus;
  current_review_step?: string | null;
  extracted?: ExtractedDocument | null;
  ocr?: OcrDocumentResult | null;
  /** The resolved schema generated from the run's registered document type. */
  extraction_schema?: Record<string, unknown> | null;
  schema_name?: string | null;
  prompt?: string | null;
  validation_errors?: Array<SchemaFieldError>;
  document_key?: string | null;
  file_name?: string | null;
  mime_type?: string | null;
  review_decision?: ReviewDecision | null;
};

export type DocumentReviewSubmission = {
  decision: ReviewDecision;
  step?: string | null;
  reviewed_output?: ExtractedDocument | null;
  note?: string | null;
};

/**
 * One run in the reviews list.
 *
 * Not the review payload: the listing knows a run exists, roughly when it started and how it
 * ended. The review state is fetched per run when a row is opened. `status` is the platform's
 * vocabulary, not the run vocabulary; `normalizeExecutionStatus` bridges the two. All fields but
 * the id are optional because the row is assembled from the ownership record.
 */
export type ReviewListItem = {
  execution_id: string;
  workflow_name?: string | null;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  total_duration_ms?: number | null;
  review_decision?: string | null;
  /** The Review column's value — `pending_review` or the decision once made; filled by the list hook, not the wire. */
  review_status?: "pending_review" | ReviewDecision | null;
};

/** The listing narrowed to what the reviews list renders. */
export type ReviewListPage = {
  executions: Array<ReviewListItem>;
  next_page_token: string | null;
};

/**
 * One row of the listing as it arrives from the auto-mounted `GET /executions`. The generic core
 * carries a neutral `outcome` badge (not a review-specific name); `toReviewListPage` maps it onto
 * this feature's `review_decision`.
 */
export type ReviewListWireItem = {
  execution_id: string;
  workflow_name?: string | null;
  status?: string | null;
  start_time?: string | null;
  end_time?: string | null;
  total_duration_ms?: number | null;
  outcome?: string | null;
};

/**
 * The listing exactly as it arrives from the auto-mounted `GET /executions`, before the mapper
 * narrows it.
 *
 * A structural supertype of the response, deliberately: it stays assignable from whatever codegen
 * emits for the executions page, so core may grow a field without breaking the mirror.
 */
export type ReviewListWirePage = {
  executions?: Array<ReviewListWireItem> | null;
  next_page_token?: string | null;
};
