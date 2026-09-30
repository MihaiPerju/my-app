import type {
  DocumentExtractionRequest,
  ExtractedDocument,
  OcrBlockResult,
  OcrDocumentResult,
  ReviewListPage,
  ReviewListWirePage,
  WorkflowRunStatus,
} from "./types";

export type DocumentFormState = {
  /** Set once the file is staged in object storage; the run carries only this key. */
  documentKey: string;
  fileName: string;
  mimeType: string;
  /** The registered document type selected for extraction. */
  schemaName: string;
  promptText: string;
};

export const INITIAL_DOCUMENT_FORM: DocumentFormState = {
  documentKey: "",
  fileName: "",
  mimeType: "",
  schemaName: "",
  promptText: "",
};

/**
 * Upload cap, matching `MAX_DOCUMENT_BYTES` in the Python schemas.
 *
 * The document travels to object storage and the run carries only its key, so the cap is
 * bounded by the upload request.
 */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;

/** The multipart body `POST /v1/document_annotation_ui/upload` expects, whose file field is named `file`. */
export function buildUploadFormData(file: File): FormData {
  const body = new FormData();
  body.append("file", file);
  return body;
}

/** Poll cadence for the review-state query while a run has not settled. */
export const REVIEW_POLL_INTERVAL_MS = 2_000;

const TERMINAL_RUN_STATUSES = new Set<WorkflowRunStatus>([
  "completed",
  "rejected",
  "failed",
  "cancelled",
]);

const SOURCE_PREFIX = "source_";

export function isTerminalRunStatus(status: WorkflowRunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

export function isWithinSizeLimit(file: File): boolean {
  return file.size <= MAX_DOCUMENT_BYTES;
}

/** How many TRAILING characters of an execution id the list shows, as the original's list did. */
const SHORT_EXECUTION_ID_LENGTH = 8;

/**
 * The platform's execution statuses, mapped to the run vocabulary the review badges speak.
 *
 * The listing reports how the workflow ended. `WorkflowRunStatus` reports how the review ended.
 * The two overlap only in part. The listing cannot report `pending_review`; that state lives in
 * the run's review state, so opening a row still fetches it.
 */
const EXECUTION_STATUS_ALIASES: Readonly<Record<string, WorkflowRunStatus>> = {
  running: "running",
  completed: "completed",
  failed: "failed",
  rejected: "rejected",
  retried: "retried",
  pending_review: "pending_review",
  cancelling: "cancelling",
  cancelled: "cancelled",
  canceled: "cancelled",
  terminated: "cancelled",
  timed_out: "failed",
  retrying_after_error: "retried",
};

/** The run status a listing row stands for, or `null` when the platform reported one we cannot map. */
export function normalizeExecutionStatus(
  status: string | null | undefined,
): WorkflowRunStatus | null {
  if (status === null || status === undefined || status === "") {
    return null;
  }
  return EXECUTION_STATUS_ALIASES[status.toLowerCase()] ?? null;
}

const ABSENT = "—";

const SECOND_MS = 1_000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * How long a run took, in the one unit worth reading.
 *
 * The platform measures this as `total_duration_ms`, so there is nothing to compute, only to
 * round. The thresholds and the `45 s` / `12 min` / `2 h` spellings match the original.
 */
export function formatRunDuration(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || durationMs < 0) {
    return ABSENT;
  }
  if (durationMs < MINUTE_MS) {
    return `${Math.round(durationMs / SECOND_MS)} s`;
  }
  if (durationMs < HOUR_MS) {
    return `${Math.round(durationMs / MINUTE_MS)} min`;
  }
  return `${Math.round(durationMs / HOUR_MS)} h`;
}

/** The tail of an execution id, enough to tell two runs apart in a list. */
export function shortExecutionId(executionId: string): string {
  return executionId.slice(-SHORT_EXECUTION_ID_LENGTH);
}

/** Narrow the reviews listing to the rows the list renders, in the order the page returned them. */
export function toReviewListPage(page: ReviewListWirePage): ReviewListPage {
  return {
    executions: (page.executions ?? []).map((execution) => ({
      execution_id: execution.execution_id,
      workflow_name: execution.workflow_name,
      status: execution.status,
      start_time: execution.start_time,
      end_time: execution.end_time,
      total_duration_ms: execution.total_duration_ms,
      review_decision: execution.outcome ?? null,
    })),
    next_page_token: page.next_page_token ?? null,
  };
}

/**
 * Build the run request from the storage key the upload route returned.
 *
 * An omitted prompt asks the backend for its own `default_prompt` instead of pinning a copy.
 */
export function buildExtractionRequest(form: DocumentFormState): DocumentExtractionRequest {
  return {
    document_key: form.documentKey,
    file_name: form.fileName || undefined,
    mime_type: form.mimeType || undefined,
    schema_name: form.schemaName.trim(),
    prompt: form.promptText.trim() || undefined,
  };
}

/** One extracted-field provenance hit: the page it sits on and the OCR block that backs it. */
export type FieldRegion = {
  /** `OcrPageResult.index`, i.e. the OCR page index — not a 1-based page number. */
  page: number;
  block: OcrBlockResult;
};

/**
 * Flatten OCR pages into the global block order the extraction prompt numbered them in.
 *
 * `_format_source_blocks` in the Python activities emits `[source_{idx}]`, incrementing `idx`
 * once per block while walking pages in list order. So `source_N` indexes this flat array, not a
 * per-page block index.
 */
function flattenBlocks(ocr: OcrDocumentResult): Array<FieldRegion> {
  const flat: Array<FieldRegion> = [];
  for (const page of ocr.pages ?? []) {
    for (const block of page.blocks) {
      flat.push({ page: page.index, block });
    }
  }
  return flat;
}

function parseSourceIndex(token: string): number | null {
  if (!token.startsWith(SOURCE_PREFIX)) {
    return null;
  }
  const raw = token.slice(SOURCE_PREFIX.length);
  // The whole suffix must be digits. `Number.parseInt` would read "source_1junk" as 1, but a
  // malformed token is meant to be skipped, not silently resolved to a block. This also rejects "".
  if (!/^\d+$/.test(raw)) {
    return null;
  }
  return Number(raw);
}

export type SourceMap = NonNullable<ExtractedDocument["_sources"]>;

/**
 * Resolve an extracted field back to the OCR blocks it was read from.
 *
 * `sources` maps a field key (dot-notated for nested keys, e.g. `"line_items.0.amount"`)
 * to `source_N` tokens. Each `N` is a global block index continuous across pages. The lookup tries
 * the exact key, then the bare leaf name (`amount`). Malformed or out-of-range tokens are skipped;
 * the result keeps the order the sources were listed in.
 */
export function getRegionsForField(
  ocr: OcrDocumentResult,
  sources: SourceMap | null | undefined,
  fieldKey: string,
): Array<FieldRegion> {
  const leafKey = fieldKey.slice(fieldKey.lastIndexOf(".") + 1);
  const tokens = sources?.[fieldKey] ?? sources?.[leafKey] ?? [];
  if (tokens.length === 0) {
    return [];
  }
  const flat = flattenBlocks(ocr);
  const regions: Array<FieldRegion> = [];
  for (const token of tokens) {
    const index = parseSourceIndex(token);
    if (index === null) {
      continue;
    }
    const region = flat[index];
    if (region) {
      regions.push(region);
    }
  }
  return regions;
}

/** Resolve every cited OCR block once, in document order. */
export function getReferencedRegions(
  ocr: OcrDocumentResult,
  sources: SourceMap | null | undefined,
): Array<FieldRegion> {
  const referencedIndices = new Set<number>();
  for (const tokens of Object.values(sources ?? {})) {
    for (const token of tokens) {
      const index = parseSourceIndex(token);
      if (index !== null) referencedIndices.add(index);
    }
  }
  return flattenBlocks(ocr).filter((_region, index) => referencedIndices.has(index));
}
