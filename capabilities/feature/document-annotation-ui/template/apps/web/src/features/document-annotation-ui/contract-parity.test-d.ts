import type {
  DocumentExtractionRequest,
  DocumentReviewState,
  DocumentReviewSubmission,
  ExtractedDocument,
  DocumentAnnotationUiWorkflowInfo,
  OcrBlockResult,
  OcrDocumentResult,
  OcrPageResult,
  ReviewListWireItem,
  UploadResult,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import type {
  DocumentExtractionRequest as GeneratedDocumentExtractionRequest,
  DocumentReviewState as GeneratedDocumentReviewState,
  DocumentReviewSubmission as GeneratedDocumentReviewSubmission,
  ExtractedDocument as GeneratedExtractedDocument,
  DocumentAnnotationUiWorkflowInfo as GeneratedDocumentAnnotationUiWorkflowInfo,
  OcrBlockResult as GeneratedOcrBlockResult,
  OcrDocumentResult as GeneratedOcrDocumentResult,
  OcrPageResult as GeneratedOcrPageResult,
  UploadResult as GeneratedUploadResult,
  WorkflowExecution as GeneratedWorkflowExecution,
} from "@/api/generated/types.gen";

/**
 * The hand-kept `@mistralai-capabilities/feature-document-annotation-ui` mirror types must stay mutually assignable with the types
 * the app generates from the FastAPI OpenAPI spec. If a schema field changes on one side only,
 * one of these assignments stops being `true` and `check-types` fails here.
 */
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

export const ocrBlockResultParity: MutuallyAssignable<OcrBlockResult, GeneratedOcrBlockResult> =
  true;
export const ocrPageResultParity: MutuallyAssignable<OcrPageResult, GeneratedOcrPageResult> = true;
export const ocrDocumentResultParity: MutuallyAssignable<
  OcrDocumentResult,
  GeneratedOcrDocumentResult
> = true;
export const extractedDocumentParity: MutuallyAssignable<
  ExtractedDocument,
  GeneratedExtractedDocument
> = true;
export const documentExtractionRequestParity: MutuallyAssignable<
  DocumentExtractionRequest,
  GeneratedDocumentExtractionRequest
> = true;
export const documentReviewStateParity: MutuallyAssignable<
  DocumentReviewState,
  GeneratedDocumentReviewState
> = true;
export const documentReviewSubmissionParity: MutuallyAssignable<
  DocumentReviewSubmission,
  GeneratedDocumentReviewSubmission
> = true;
export const uploadResultParity: MutuallyAssignable<UploadResult, GeneratedUploadResult> = true;

// The catalog entry `/workflows` returns. `show_debug` and `review_step` are declared once in
// `workflows_catalog.py`, and this is what pins the web layer to that rather than to a restatement.
export const documentAnnotationUiWorkflowInfoParity: MutuallyAssignable<
  DocumentAnnotationUiWorkflowInfo,
  GeneratedDocumentAnnotationUiWorkflowInfo
> = true;

// The reviews list is the auto-mounted `GET /executions`, whose item (`WorkflowExecution`) is a
// SUPERSET of the wire shape the mapper reads. So this is one-directional: every field
// `ReviewListWireItem` reads (including the generic `outcome` badge) must exist on the generated
// item; `toReviewListPage` narrows the rest away. Not mutual — the generated item carries
// `result`/`run_id`/… the list has no use for.
type AssignableFrom<Narrow, Wide> = [Wide] extends [Narrow] ? true : never;
export const reviewListItemFromExecution: AssignableFrom<
  ReviewListWireItem,
  GeneratedWorkflowExecution
> = true;
