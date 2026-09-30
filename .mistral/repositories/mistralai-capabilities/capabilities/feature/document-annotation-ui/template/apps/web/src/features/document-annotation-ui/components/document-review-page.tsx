/**
 * The Document Annotation UI surface: pick a run to review, or start one, then check the extraction against the page.
 *
 * The `view` state alone selects one of three shapes: the run list, the upload form, and the review
 * screen; there is no router. The document reaches the viewer from an upload's `File` directly, or
 * by refetching a listed run from storage, with the OCR page rasters as the only fallback.
 */

import { Button, ButtonLeadIcon } from "@mistralai/ui/button";
import { Flex } from "@mistralai/ui/flex";
import { TypographyP } from "@mistralai/ui/typography";
import {
  ArrowLeftIcon,
  CheckCircleIcon,
  PlusIcon,
  WarningIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  buildExtractionRequest,
  INITIAL_DOCUMENT_FORM,
  isWithinSizeLimit,
  MAX_DOCUMENT_BYTES,
  type DocumentFormState,
  type DocumentReviewState,
  type DocumentTypeInfo,
  type ExtractedDocument,
  type DocumentAnnotationUiWorkflowInfo,
  type RunDisplayStatus,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import {
  ErrorState,
  Field,
  FileInput,
  ProductPage,
  ProductSection,
  SelectInput,
  TextAreaInput,
} from "@mistralai-capabilities/feature-mistral-design-system/components";

import {
  useInvalidateReviewsList,
  useReviewDocumentQuery,
  useReviewStateQuery,
  useSchemasQuery,
  useStartExtractionMutation,
  useSubmitReviewMutation,
  useUploadDocumentMutation,
  useWorkflowsQuery,
} from "../use-document-annotation-ui";
import { ReviewsList } from "./reviews-list";
import { ReviewScreen } from "./review-screen";
import { RunStatusBadge } from "./run-status-badge";
import { resolveSelectedWorkflow } from "./workflow-logic";

const PAGE_DESCRIPTION =
  "Upload a document and pick its type, let OCR and extraction do the first pass, then check every field against the page it came from before approving it.";

const UPLOAD_DESCRIPTION =
  "The document is stored in object storage and the run references it by key. Pick the registered document type to extract.";

const MAX_MEGABYTES = (MAX_DOCUMENT_BYTES / (1024 * 1024)).toFixed(0);

const SELECTED_SCHEMA_DESCRIPTION = "The registered schema this document type extracts against.";

const PROMPT_DESCRIPTION =
  "Debug mode: the system prompt the extraction runs with. Pre-filled with the server default; edit it to steer this run only.";

const PROMPT_ROWS = 12;

type ExtractionFormState = DocumentFormState;
type Decision = "APPROVED" | "REJECTED";

type View = "list" | "new" | "detail";

const INITIAL_FORM: ExtractionFormState = INITIAL_DOCUMENT_FORM;

const clearDocument = (prev: ExtractionFormState): ExtractionFormState => ({
  ...prev,
  documentKey: "",
  fileName: "",
  mimeType: "",
});

function UploadPanel({
  form,
  setForm,
  sizeError,
  setSizeError,
  onStart,
  onUpload,
  onDocumentReady,
  isUploading,
  uploadError,
  isPending,
  workflows,
  selectedWorkflow,
  onSelectWorkflow,
  documentTypes,
  onSelectSchemaName,
}: {
  form: ExtractionFormState;
  setForm: (update: (prev: ExtractionFormState) => ExtractionFormState) => void;
  sizeError: string | null;
  setSizeError: (next: string | null) => void;
  onStart: () => void;
  onUpload: (file: File) => Promise<string>;
  onDocumentReady: (file: File | null) => void;
  isUploading: boolean;
  uploadError: unknown;
  isPending: boolean;
  workflows: ReadonlyArray<DocumentAnnotationUiWorkflowInfo>;
  selectedWorkflow: DocumentAnnotationUiWorkflowInfo | null;
  onSelectWorkflow: (name: string) => void;
  documentTypes: ReadonlyArray<DocumentTypeInfo>;
  onSelectSchemaName: (schemaName: string) => void;
}) {
  const showDebug = selectedWorkflow?.show_debug === true;
  const uploadTokenRef = useRef(0);

  const handleFile = async (file: File | null) => {
    if (!file) {
      uploadTokenRef.current += 1;
      setSizeError(null);
      setForm(clearDocument);
      onDocumentReady(null);
      return;
    }
    if (!isWithinSizeLimit(file)) {
      uploadTokenRef.current += 1;
      setSizeError(
        `"${file.name}" is ${(file.size / (1024 * 1024)).toFixed(1)} MB, over the ${MAX_MEGABYTES} MB upload limit.`,
      );
      setForm(clearDocument);
      onDocumentReady(null);
      return;
    }
    setSizeError(null);
    // Clear the staged document BEFORE the await: while the replacement uploads, `canStart` must be
    // false so a submit cannot start extraction against the PREVIOUS document's key. The token guards
    // a slow first upload resolving after a fast second one and overwriting the newer key OR bytes.
    const token = (uploadTokenRef.current += 1);
    setForm(clearDocument);
    onDocumentReady(null);
    try {
      const documentKey = await onUpload(file);
      if (uploadTokenRef.current !== token) return;
      // Commit the key AND the viewer bytes together, inside the guard, so they can never come from
      // different uploads. Functional update: schema/prompt typed during the await must survive.
      setForm((prev) => ({ ...prev, documentKey, fileName: file.name, mimeType: file.type }));
      onDocumentReady(file);
    } catch {
      if (uploadTokenRef.current === token) {
        setForm(clearDocument);
        onDocumentReady(null);
      }
    }
  };

  const hasFile = form.documentKey !== "";
  const canStart = selectedWorkflow !== null && hasFile && form.schemaName !== "";

  // The schema a selected named type will extract against, shown read-only. Served on the registry
  // (GET /schemas), so it renders on selection without a prior run.
  const selectedType = documentTypes.find((documentType) => documentType.name === form.schemaName);
  const selectedSchemaJson = selectedType
    ? JSON.stringify(selectedType.json_schema, null, 2)
    : null;

  return (
    <ProductSection description={UPLOAD_DESCRIPTION} title="New document">
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (!canStart) return;
          onStart();
        }}
      >
        <Flex direction="column" gap={4}>
          {selectedWorkflow ? (
            <SelectInput
              description={selectedWorkflow.description}
              id="document-annotation-ui-workflow"
              label="Workflow"
              onChange={onSelectWorkflow}
              options={workflows.map((workflow) => ({
                value: workflow.name,
                label: workflow.display_name,
              }))}
              value={selectedWorkflow.name}
            />
          ) : null}
          <SelectInput
            description="The registered schema the run extracts with."
            id="document-annotation-ui-document-type"
            label="Document type"
            onChange={onSelectSchemaName}
            options={documentTypes.map((documentType) => ({
              value: documentType.name,
              label: documentType.display_name,
            }))}
            value={form.schemaName}
          />
          <FileInput
            accept="application/pdf,image/*"
            description={`PDF or image, up to ${MAX_MEGABYTES} MB.`}
            fileName={form.fileName}
            id="document-annotation-ui-document"
            label="Document"
            onFile={handleFile}
            required={!hasFile}
          />
          {sizeError ? (
            <TypographyP className="text-destructive" size="sm">
              {sizeError}
            </TypographyP>
          ) : null}
          {uploadError ? (
            <ErrorState error={uploadError} title="Could not upload the document" />
          ) : null}
          {selectedSchemaJson !== null ? (
            <Field
              htmlFor="document-annotation-ui-selected-schema"
              label="Extraction schema"
              description={SELECTED_SCHEMA_DESCRIPTION}
            >
              <pre
                className="border-default bg-input text-muted max-h-64 overflow-auto rounded-card-sm border px-3 py-2 text-xs leading-5"
                id="document-annotation-ui-selected-schema"
              >
                {selectedSchemaJson}
              </pre>
            </Field>
          ) : null}
          {showDebug ? (
            <TextAreaInput
              description={PROMPT_DESCRIPTION}
              id="document-annotation-ui-prompt"
              label="System prompt (debug)"
              onChange={(promptText) => setForm((prev) => ({ ...prev, promptText }))}
              rows={PROMPT_ROWS}
              value={form.promptText}
            />
          ) : null}
          <Button isDisabled={!canStart} isLoading={isUploading || isPending} type="submit">
            Extract document
          </Button>
        </Flex>
      </form>
    </ProductSection>
  );
}

/**
 * The banner under the top bar for every settled run.
 *
 * Green means the reviewer approved the run. Amber means the reviewer did not. This reading must be
 * clear at a glance. The colors use the design system `success` / `warning` / `destructive` tokens,
 * so the reading survives dark mode.
 */
function StatusCallout({ status }: { status: RunDisplayStatus }) {
  if (status === "failed") {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-destructive/40 bg-destructive/10 px-4 py-3">
        <WarningIcon aria-hidden className="size-5 shrink-0 text-destructive" />
        <div className="flex-1">
          <p className="text-sm font-medium text-destructive">This run failed.</p>
          <p className="mt-0.5 text-xs text-destructive">
            Start a new document to retry, or check the run's logs for the cause.
          </p>
        </div>
      </div>
    );
  }

  if (status === "cancelled") {
    return (
      <div className="flex shrink-0 items-center gap-3 border-b border-default bg-subtle px-4 py-3">
        <XCircleIcon aria-hidden className="size-5 shrink-0 text-muted" />
        <p className="flex-1 text-sm font-medium text-muted">
          This run was cancelled before it produced a reviewed result.
        </p>
      </div>
    );
  }

  if (status === "completed" || status === "approved" || status === "rejected") {
    const isRejected = status === "rejected";
    const message =
      status === "rejected"
        ? "This run was rejected."
        : status === "approved"
          ? "This run was approved."
          : "This run completed successfully.";
    return (
      <div
        className={`flex shrink-0 items-center gap-3 border-b px-4 py-3 ${
          isRejected ? "border-warning/40 bg-warning/10" : "border-success/40 bg-success/10"
        }`}
      >
        {isRejected ? (
          <XCircleIcon aria-hidden className="size-5 shrink-0 text-warning" />
        ) : (
          <CheckCircleIcon aria-hidden className="size-5 shrink-0 text-success" />
        )}
        <p className={`flex-1 text-sm font-medium ${isRejected ? "text-warning" : "text-success"}`}>
          {message}
        </p>
      </div>
    );
  }

  return null;
}

export function DocumentReviewPage() {
  const [view, setView] = useState<View>("list");
  const [form, setForm] = useState<ExtractionFormState>(INITIAL_FORM);
  const [sizeError, setSizeError] = useState<string | null>(null);
  const [executionId, setExecutionId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ExtractedDocument | null>(null);
  const [note, setNote] = useState("");
  const [documentFile, setDocumentFile] = useState<File | null>(null);
  const [decided, setDecided] = useState<{ decision: Decision; note: string; at: string } | null>(
    null,
  );
  const [selectedWorkflowName, setSelectedWorkflowName] = useState<string | null>(null);
  // The workflow of a run opened from the list, carried on the row. A detail view must render debug
  // controls and tabs for THAT run's workflow, not the upload form's page-local selection — in a
  // multi-workflow catalog those differ, and reading the form selection would show the wrong one.
  const [openedWorkflowName, setOpenedWorkflowName] = useState<string | null>(null);

  /**
   * What extraction produced, captured the first time the run reports it.
   *
   * The workflow replaces `extracted` with the reviewed output once a decision lands. This snapshot
   * is the only surviving copy of the AI output. The Review tab diff and the "edited" markers in
   * the Extraction tab measure against it.
   */
  const aiOutputRef = useRef<ExtractedDocument | null>(null);
  const [aiOutput, setAiOutput] = useState<ExtractedDocument | null>(null);

  const uploadMutation = useUploadDocumentMutation();
  const workflowsQuery = useWorkflowsQuery();
  const schemasQuery = useSchemasQuery();
  const invalidateReviewsList = useInvalidateReviewsList();
  const workflows = useMemo(() => workflowsQuery.data ?? [], [workflowsQuery.data]);
  const selectedWorkflow = useMemo(
    () => resolveSelectedWorkflow(workflows, selectedWorkflowName),
    [selectedWorkflowName, workflows],
  );
  // The workflow the open detail view belongs to: the opened run's own workflow, resolved from the
  // row rather than the upload form's selection. Falls back to `selectedWorkflow` for a run just
  // started from the form (its workflow IS the selected one) or a legacy row with no workflow_name.
  const activeWorkflow = useMemo(
    () =>
      openedWorkflowName === null
        ? selectedWorkflow
        : resolveSelectedWorkflow(workflows, openedWorkflowName),
    [openedWorkflowName, selectedWorkflow, workflows],
  );
  const startMutation = useStartExtractionMutation(selectedWorkflow);
  const submitMutation = useSubmitReviewMutation(activeWorkflow);
  const reviewQuery = useReviewStateQuery(activeWorkflow, executionId);

  const documentTypes = useMemo(
    () => schemasQuery.data?.document_types ?? [],
    [schemasQuery.data?.document_types],
  );
  const defaultPrompt = schemasQuery.data?.default_prompt ?? "";
  const defaultSchemaName = documentTypes[0]?.name ?? "";

  const state: DocumentReviewState | null = reviewQuery.data ?? null;
  const extracted = state?.extracted ?? null;

  /*
   * Fetch the stored document only for a run this tab did not upload.
   *
   * `documentFile !== null` is the upload path and already holds the bytes. A missing
   * `document_key` means there is nothing to ask for, so requesting it would return a 404 where the
   * OCR fallback is correct. Nulling the id switches the query off. The route derives its own key.
   */
  const storedDocumentExecutionId =
    documentFile === null && executionId !== null && Boolean(state?.document_key)
      ? executionId
      : null;
  const documentQuery = useReviewDocumentQuery(activeWorkflow, storedDocumentExecutionId);

  const storedFile = useMemo(() => {
    const blob = documentQuery.data;
    if (!blob) return null;
    return new File([blob], state?.file_name || "document", {
      type: state?.mime_type || blob.type || "application/octet-stream",
    });
  }, [documentQuery.data, state?.file_name, state?.mime_type]);

  // The viewer cannot tell the two apart, and that is the point: a reopened review renders through
  // exactly the same `PdfViewer` / `ImageViewer` path, with the same overlays, as a fresh upload.
  const viewerFile = documentFile ?? storedFile;
  const viewerFileName = form.fileName || state?.file_name || "";
  const viewerMimeType = form.mimeType || state?.mime_type || "";

  useEffect(() => {
    if (!extracted || aiOutputRef.current !== null) return;
    aiOutputRef.current = extracted;
    setAiOutput(extracted);
    setDraft(extracted);
  }, [extracted]);

  // Seed the form once when the server defaults first land. Later transitions seed through reset().
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current || (defaultSchemaName === "" && defaultPrompt === "")) return;
    seededRef.current = true;
    setForm((prev) => ({
      ...prev,
      schemaName: prev.schemaName === "" ? defaultSchemaName : prev.schemaName,
      promptText: prev.promptText === "" ? defaultPrompt : prev.promptText,
    }));
  }, [defaultSchemaName, defaultPrompt]);

  // Pure upload: returns the key and sets NO state. The staged file bytes are committed by
  // UploadPanel inside its token guard (via onDocumentReady), atomically with the key, so a slow
  // earlier upload resolving last cannot leave the viewer showing its bytes under a newer run's key.
  const uploadDocument = async (file: File) => {
    const result = await uploadMutation.mutateAsync(file);
    return result.document_key;
  };

  const selectSchemaName = (schemaName: string) => {
    setForm((prev) => ({ ...prev, schemaName }));
  };

  const selectWorkflowName = (workflowName: string) => {
    setSelectedWorkflowName(workflowName);
    setForm((prev) => (prev.schemaName === "" ? { ...prev, schemaName: defaultSchemaName } : prev));
  };

  const startRun = () => {
    if (selectedWorkflow === null) return;
    if (form.schemaName === "") return;
    startMutation.mutate(buildExtractionRequest(form), {
      onSuccess: ({ execution_id }: { execution_id: string }) => {
        aiOutputRef.current = null;
        setAiOutput(null);
        setDraft(null);
        setDecided(null);
        setNote("");
        setOpenedWorkflowName(selectedWorkflow.name);
        setExecutionId(execution_id);
        setView("detail");
      },
    });
  };

  const reset = () => {
    setExecutionId(null);
    aiOutputRef.current = null;
    setAiOutput(null);
    setDraft(null);
    setDecided(null);
    setNote("");
    setSizeError(null);
    setDocumentFile(null);
    setOpenedWorkflowName(null);
    setForm({ ...INITIAL_FORM, schemaName: defaultSchemaName, promptText: defaultPrompt });
    uploadMutation.reset();
    startMutation.reset();
    submitMutation.reset();
  };

  const startNewReview = () => {
    reset();
    setView("new");
  };

  /**
   * Always invalidates, not only after a decision: a run STARTED and then backed out of is just as
   * absent from the list the user is returning to.
   */
  const backToList = () => {
    reset();
    invalidateReviewsList();
    setView("list");
  };

  const openReview = (id: string, workflowName: string | null) => {
    reset();
    setOpenedWorkflowName(workflowName);
    setExecutionId(id);
    setView("detail");
  };

  const submit = (decision: Decision) => {
    if (executionId === null || activeWorkflow === null) return;
    const trimmed = note.trim();
    // Reflect the decision immediately: signalling the workflow and letting it finalize takes a
    // couple of round-trips, and until they land `state.status` is still `pending_review`, which
    // would otherwise flash the review controls back as if nothing happened.
    setDecided({ decision, note: trimmed, at: new Date().toISOString() });
    submitMutation.mutate(
      {
        executionId,
        body: {
          decision: decision === "APPROVED" ? "approved" : "rejected",
          reviewed_output: decision === "APPROVED" ? draft : null,
          note: trimmed === "" ? null : trimmed,
        },
      },
      {
        // Pull the finalized status now instead of waiting for the next poll tick.
        onSuccess: () => {
          void reviewQuery.refetch();
        },
        // Roll back the optimistic decision so the reviewer can retry; the error surfaces below.
        onError: () => setDecided(null),
      },
    );
  };

  const backToListButton = (
    <Button onClick={backToList} size="sm" type="button" variant="ghost">
      <ButtonLeadIcon icon={ArrowLeftIcon} />
      All reviews
    </Button>
  );

  if (view === "list") {
    return (
      <ProductPage
        actions={
          <Button onClick={startNewReview} type="button" variant="brand">
            <ButtonLeadIcon icon={PlusIcon} />
            New review
          </Button>
        }
        contentWidth="full"
        description={PAGE_DESCRIPTION}
        eyebrow="Document Annotation UI"
        title="Document extraction"
      >
        <ReviewsList onNew={startNewReview} onOpen={openReview} />
      </ProductPage>
    );
  }

  /*
   * `executionId === null` is the upload form's real condition, not just `view === "new"`: it also
   * catches the impossible detail-without-a-run, and it is what narrows `executionId` to a string
   * for `ReviewScreen` below.
   */
  if (view === "new" || executionId === null) {
    return (
      <ProductPage
        contentWidth="full"
        description={PAGE_DESCRIPTION}
        eyebrow="Document Annotation UI"
        title="Document extraction"
        topBar={backToListButton}
      >
        <UploadPanel
          documentTypes={documentTypes}
          form={form}
          isPending={startMutation.isPending}
          isUploading={uploadMutation.isPending}
          onDocumentReady={setDocumentFile}
          onSelectSchemaName={selectSchemaName}
          onSelectWorkflow={selectWorkflowName}
          onStart={startRun}
          onUpload={uploadDocument}
          selectedWorkflow={selectedWorkflow}
          setForm={setForm}
          setSizeError={setSizeError}
          sizeError={sizeError}
          uploadError={uploadMutation.error}
          workflows={workflows}
        />
      </ProductPage>
    );
  }

  const newDocumentButton = (
    <Button onClick={startNewReview} size="sm" type="button" variant="secondary">
      New document
    </Button>
  );

  if (startMutation.error || reviewQuery.error || state === null) {
    const error = startMutation.error ?? reviewQuery.error;
    return (
      <ProductPage
        contentWidth="full"
        description={PAGE_DESCRIPTION}
        title="Document extraction"
        topBar={backToListButton}
      >
        <ProductSection actions={newDocumentButton} title="Review">
          {error ? (
            <ErrorState error={error} title="Could not load the run" />
          ) : (
            <TypographyP size="sm" variant="muted">
              Waiting for the run to report in…
            </TypographyP>
          )}
        </ProductSection>
      </ProductPage>
    );
  }

  // A decided run reads `completed` at the platform level; the persisted `review_decision` is what
  // turns the badge and callout into Approved/Rejected — consistent with the list, no extra query.
  const displayStatus = state.review_decision ?? state.status;
  return (
    <ReviewScreen
      aiOutput={aiOutput}
      backAction={backToListButton}
      debugEnabled={activeWorkflow?.show_debug}
      decisionRecorded={decided !== null || state.review_decision != null}
      draft={draft}
      executionId={executionId}
      file={viewerFile}
      fileError={documentQuery.error}
      fileName={viewerFileName}
      isFileLoading={documentQuery.isPending && storedDocumentExecutionId !== null}
      isSubmitting={submitMutation.isPending}
      mimeType={viewerMimeType}
      note={note}
      onApprove={() => submit("APPROVED")}
      onDraftChange={setDraft}
      onNoteChange={setNote}
      onReject={() => submit("REJECTED")}
      onResetDraft={() => setDraft(aiOutput)}
      state={state}
      statusBadge={<RunStatusBadge status={displayStatus} />}
      statusCallout={<StatusCallout status={displayStatus} />}
      submitError={submitMutation.error}
      topBarActions={newDocumentButton}
      workflow={activeWorkflow}
    />
  );
}
