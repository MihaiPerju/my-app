/**
 * The review screen: the document on the left, its extraction on the right, one decision at the
 * bottom.
 *
 * A port of the original run page's split pane. The two halves are linked both ways: pointing at a
 * field outlines the blocks it came from, and pointing at a rendered OCR element highlights the
 * same region. The divider is draggable because the right split depends on the document.
 */

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";

import { Badge } from "@mistralai/ui/badge";
import { Button, ButtonLeadIcon } from "@mistralai/ui/button";
import { Input } from "@mistralai/ui/input";
import { Tab, Tabs, TabsList } from "@mistralai/ui/tabs";
import {
  ArrowSquareOutIcon,
  CheckCircleIcon,
  CircleNotchIcon,
  EraserIcon,
  FileIcon,
  XCircleIcon,
} from "@phosphor-icons/react";

import type {
  DocumentReviewState,
  ExtractedDocument,
  DocumentAnnotationUiWorkflowInfo,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import { DebugPanel } from "./debug-panel";
import { DocumentViewer } from "./document-viewer";
import { HtmlPanel } from "./html-panel";
import { OutputPanel } from "./output-panel";

// The Markdown and OCR panels render through `@mistralai/ui`'s `<Markdown>`, which statically pulls
// katex + shiki (and shiki's `onig.wasm`) — heavy, SSR-hostile deps this app server-renders around
// (chat avoids the same component for this reason). Loading them lazily code-splits shiki OUT of the
// server bundle: the panels only mount client-side, behind their tab, so the review route SSRs
// without the wasm. Named exports are adapted to the default `lazy` expects.
const MarkdownPanel = lazy(() =>
  import("./markdown-panel").then((module) => ({ default: module.MarkdownPanel })),
);
const OcrPanel = lazy(() => import("./ocr-panel").then((module) => ({ default: module.OcrPanel })));
import { writeFieldValue } from "./field-panel-logic";
import { decodeDocumentData, isJsonString } from "./json-value";
import { isExtractionSchema } from "./extraction-schema";
import { isOutputTab, outputTabsFor, TAB_LABELS, type OutputTab } from "./workflow-logic";
import {
  buildOcrRegionIndex,
  firstRegionId,
  getAllOcrRegions,
  getFieldRegions,
  getReferencedFieldRegions,
  getTableRegions,
  groupByPageNumber,
} from "./regions";

type WorkflowRoute = Pick<DocumentAnnotationUiWorkflowInfo, "name" | "route_segment"> | null;

function consoleUrl(workflowName: string, executionId: string): string {
  return `https://console.mistral.ai/build/workflows/${workflowName}?executionId=${executionId}`;
}

/** Tabs that show the run rather than let it be edited, so the Reset control has nothing to do. */
const READ_ONLY_TABS = new Set<OutputTab>(["text", "debug"]);

/**
 * The divider between the panes.
 *
 * Hand-rolled rather than `react-resizable-panels` to match the original's feel exactly: a 4px
 * hairline that takes the brand colour on hover, and a drag that the parent tracks in pixels.
 */
function PanelLoading() {
  return (
    <div className="flex h-full items-center justify-center">
      <p className="text-muted text-sm">Loading…</p>
    </div>
  );
}

const RESIZE_KEY_STEP = 24;

function ResizeDivider({
  onResizeStart,
  onResizeMove,
  onResizeByDelta,
  onResizeEnd,
}: {
  onResizeStart: (clientX: number) => void;
  onResizeMove: (clientX: number) => void;
  onResizeByDelta: (delta: number) => void;
  onResizeEnd: () => void;
}) {
  return (
    <div
      aria-label="Resize panels"
      aria-orientation="vertical"
      className="hover:bg-warning w-1 shrink-0 cursor-col-resize touch-none bg-[var(--border-default)] select-none"
      onKeyDown={(event) => {
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          onResizeByDelta(RESIZE_KEY_STEP);
        } else if (event.key === "ArrowRight") {
          event.preventDefault();
          onResizeByDelta(-RESIZE_KEY_STEP);
        }
      }}
      onLostPointerCapture={onResizeEnd}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        onResizeStart(event.clientX);
      }}
      onPointerMove={(event) => {
        if (event.currentTarget.hasPointerCapture(event.pointerId)) onResizeMove(event.clientX);
      }}
      // eslint-disable-next-line jsx-a11y/prefer-tag-over-role -- a focusable APG window-splitter is not an <hr>; <hr> cannot carry a drag gesture
      role="separator"
      tabIndex={0}
    />
  );
}

function readStringField(document: ExtractedDocument | null, key: string): string | null {
  if (document === null) return null;
  const value = decodeDocumentData(document)[key];
  return isJsonString(value) ? value : null;
}

export type ReviewScreenProps = {
  state: DocumentReviewState;
  executionId: string;
  aiOutput: ExtractedDocument | null;
  draft: ExtractedDocument | null;
  onDraftChange: (next: ExtractedDocument) => void;
  onResetDraft: () => void;
  file: File | null;
  fileName: string;
  mimeType: string;
  isFileLoading?: boolean;
  fileError?: unknown;
  note: string;
  onNoteChange: (note: string) => void;
  onApprove: () => void;
  onReject: () => void;
  isSubmitting: boolean;
  submitError: unknown;
  decisionRecorded: boolean;
  statusCallout: ReactNode;
  topBarActions: ReactNode;
  statusBadge: ReactNode;
  workflow: WorkflowRoute;
  /** The way out, rendered ahead of the filename — leftmost, where a back control is looked for. */
  backAction?: ReactNode;
  /** The selected workflow's `show_debug`, resolved at the page level. Adds the Debug tab. */
  debugEnabled?: boolean;
};

export function ReviewScreen({
  state,
  executionId,
  aiOutput,
  draft,
  onDraftChange,
  onResetDraft,
  file,
  fileName,
  mimeType,
  isFileLoading,
  fileError,
  note,
  onNoteChange,
  onApprove,
  onReject,
  isSubmitting,
  submitError,
  decisionRecorded,
  statusCallout,
  topBarActions,
  statusBadge,
  workflow,
  backAction,
  debugEnabled,
}: ReviewScreenProps) {
  const [activeTab, setActiveTab] = useState<OutputTab>("structured");
  const [hoveredFieldKey, setHoveredFieldKey] = useState<string | null>(null);
  const [hoveredRegionId, setHoveredRegionId] = useState<string | null>(null);
  const [processWidth, setProcessWidth] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false);

  const panelsRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ lastX: number } | null>(null);
  const scrollToRegionRef: RefObject<((regionId: string) => void) | null> = useRef<
    ((regionId: string) => void) | null
  >(null);

  const isPendingReview = state.status === "pending_review";
  const ocr = state.ocr ?? null;
  const displayed = draft ?? state.extracted ?? null;

  // Decode the wire `json_schema` once, here at the boundary, so every panel downstream works on the
  // typed `ExtractionSchema` contract rather than re-reading an untyped bag of keywords.
  const extractionSchema = useMemo(
    () => (isExtractionSchema(state.extraction_schema) ? state.extraction_schema : null),
    [state.extraction_schema],
  );

  const markdown = readStringField(displayed, "markdown");
  const html = readStringField(displayed, "html");

  const allOcrRegions = useMemo(() => getAllOcrRegions(ocr), [ocr]);
  const tableRegions = useMemo(() => getTableRegions(ocr), [ocr]);
  const tableRegionsByPage = useMemo(() => groupByPageNumber(tableRegions), [tableRegions]);
  const tableRegionIds = useMemo(() => tableRegions.map((region) => region.id), [tableRegions]);
  const ocrRegionIndex = useMemo(() => buildOcrRegionIndex(ocr), [ocr]);
  const displayedSources = displayed?.["_sources"];
  const fieldRegions = useMemo(
    () => getFieldRegions(ocrRegionIndex, displayedSources, hoveredFieldKey),
    [ocrRegionIndex, displayedSources, hoveredFieldKey],
  );
  const referencedFieldRegions = useMemo(
    () => getReferencedFieldRegions(ocrRegionIndex, displayedSources),
    [ocrRegionIndex, displayedSources],
  );

  // The catalog decides which tabs a workflow OFFERS; the run decides which of those have anything
  // to show. Review and Debug always do — an absent schema or prompt is itself the debug answer.
  const tabs = useMemo<Array<OutputTab>>(() => {
    const hasData: Record<OutputTab, boolean> = {
      markdown: markdown !== null,
      html: html !== null,
      structured: displayed !== null,
      text: ocr !== null && ocr.ocr_text.trim() !== "",
      debug: true,
    };
    return outputTabsFor({ show_debug: debugEnabled === true }).filter((tab) => hasData[tab]);
  }, [markdown, html, displayed, ocr, debugEnabled]);

  const effectiveTab: OutputTab = tabs.includes(activeTab) ? activeTab : (tabs[0] ?? "structured");

  const detectedRegionsByPage = useMemo(() => {
    if (effectiveTab === "text") return allOcrRegions;
    if (effectiveTab === "markdown") return tableRegionsByPage;
    if (effectiveTab === "structured") return referencedFieldRegions;
    return new Map();
  }, [effectiveTab, allOcrRegions, tableRegionsByPage, referencedFieldRegions]);

  /**
   * Ask the viewer to bring a region into view, after React has finished the current commit.
   *
   * `scrollToRegion` sets page state inside `flushSync` to measure the page it switched to. Calling
   * it straight from an effect flushes while React still commits, which React 19 refuses. Deferring
   * a frame also lets the target page lay out first.
   */
  const scrollToRegion = useCallback((regionId: string) => {
    const frame = requestAnimationFrame(() => scrollToRegionRef.current?.(regionId));
    return () => cancelAnimationFrame(frame);
  }, []);

  // Following the link is the point of it: a field's blocks are usually not on the page the
  // reviewer is looking at, so the viewer is told to bring the first one into view.
  useEffect(() => {
    if (hoveredFieldKey === null) return undefined;
    const target = firstRegionId(fieldRegions);
    if (target === null) return undefined;
    return scrollToRegion(target);
  }, [hoveredFieldKey, fieldRegions, scrollToRegion]);

  useEffect(() => {
    if (hoveredRegionId === null) return undefined;
    return scrollToRegion(hoveredRegionId);
  }, [hoveredRegionId, scrollToRegion]);

  const startDrag = useCallback((clientX: number) => {
    dragRef.current = { lastX: clientX };
    setIsDragging(true);
  }, []);

  const resizeProcessPane = useCallback((next: number) => {
    const container = panelsRef.current;
    if (!container) return;
    const bounds = container.getBoundingClientRect();
    // Both panes stay usable: neither the page nor the fields can be dragged to nothing.
    setProcessWidth(Math.min(Math.max(next, 320), Math.max(bounds.width - 320, 320)));
  }, []);

  const onDragMove = useCallback(
    (clientX: number) => {
      const drag = dragRef.current;
      const container = panelsRef.current;
      if (!drag || !container) return;
      const bounds = container.getBoundingClientRect();
      resizeProcessPane(bounds.right - clientX);
      drag.lastX = clientX;
    },
    [resizeProcessPane],
  );

  const resizeByKeyboard = useCallback(
    (delta: number) => {
      const container = panelsRef.current;
      if (!container) return;
      const bounds = container.getBoundingClientRect();
      resizeProcessPane((processWidth ?? bounds.width / 2) + delta);
    },
    [processWidth, resizeProcessPane],
  );

  const stopDrag = useCallback(() => {
    dragRef.current = null;
    setIsDragging(false);
  }, []);

  // The pointer-captured divider no longer paints a full-screen overlay, so the resize cursor is
  // held on the body for the duration of the drag instead.
  useEffect(() => {
    if (!isDragging) return undefined;
    const previous = document.body.style.cursor;
    document.body.style.cursor = "col-resize";
    return () => {
      document.body.style.cursor = previous;
    };
  }, [isDragging]);

  const viewerHoveredRegionId =
    effectiveTab === "structured"
      ? firstRegionId(fieldRegions)
      : effectiveTab === "text" || effectiveTab === "markdown"
        ? hoveredRegionId
        : null;

  const pageCount = ocr?.page_count ?? null;

  return (
    <div className="flex min-h-0 w-full flex-1 flex-col">
      <div className="border-default flex shrink-0 flex-wrap items-center justify-between gap-3 border-b px-4 py-3">
        <div className="flex min-w-0 flex-wrap items-center gap-3">
          {backAction}
          <span className="text-default truncate text-sm font-medium">
            {fileName || "Document"}
          </span>
          {statusBadge}
          {state.current_review_step ? (
            <Badge bordered size="sm" variant="orange">
              {state.current_review_step.replaceAll("_", " ")}
            </Badge>
          ) : null}
          {workflow ? (
            <a
              className="text-subtle hover:text-default flex items-center gap-1 text-xs"
              href={consoleUrl(workflow.name, executionId)}
              rel="noopener noreferrer"
              target="_blank"
            >
              <ArrowSquareOutIcon aria-hidden className="size-3" />
              Console
            </a>
          ) : null}
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">{topBarActions}</div>
      </div>

      {statusCallout}

      <div className="relative flex min-h-0 flex-1 overflow-hidden" ref={panelsRef}>
        {/*
         * This strip stays dark in BOTH themes, unlike the rest of the app. It is the viewer's own
         * title bar, sitting on a component that paints itself `--zinc-1000` and its toolbar
         * `--zinc-800` regardless of theme. Matching that token keeps the strip and viewer reading
         * as one panel; a theme-flipping surface put a white band above the near-black viewer.
         */}
        <div className="flex min-w-0 flex-1 flex-col bg-(--zinc-1000)">
          <div className="flex shrink-0 items-center bg-(--zinc-800)">
            <FileIcon aria-hidden className="ml-3 size-4 shrink-0 text-brand-500" />
            <span className="text-white-default ml-2 flex-1 truncate py-2.5 text-sm font-medium">
              {fileName || "Document"}
            </span>
            <div className="text-white-muted flex items-center gap-3 px-3 text-xs">
              {pageCount !== null ? (
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-informative" />
                  {pageCount} {pageCount === 1 ? "page" : "pages"}
                </span>
              ) : null}
              {detectedRegionsByPage.size > 0 ? (
                <span className="flex items-center gap-1.5">
                  <span className="size-1.5 rounded-full bg-success" />
                  {[...detectedRegionsByPage.values()].reduce(
                    (total, list) => total + list.length,
                    0,
                  )}{" "}
                  regions
                </span>
              ) : null}
            </div>
          </div>

          <div className="min-h-0 flex-1 overflow-hidden">
            <DocumentViewer
              detectedRegionsByPage={detectedRegionsByPage}
              executionId={executionId}
              file={file}
              fileError={fileError}
              fileName={fileName}
              hoveredRegionId={viewerHoveredRegionId}
              isFileLoading={isFileLoading}
              mimeType={mimeType}
              ocr={ocr}
              scrollToRegionRef={scrollToRegionRef}
              workflow={workflow}
            />
          </div>
        </div>

        <div className="flex shrink-0 flex-col" style={{ width: processWidth ?? "50%" }}>
          <div className="flex min-h-0 flex-1">
            <ResizeDivider
              onResizeStart={startDrag}
              onResizeMove={onDragMove}
              onResizeByDelta={resizeByKeyboard}
              onResizeEnd={stopDrag}
            />
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="border-default flex shrink-0 items-center border-b pl-2">
                <Tabs
                  onValueChange={(value) => {
                    if (isOutputTab(value)) setActiveTab(value);
                  }}
                  value={effectiveTab}
                >
                  <TabsList>
                    {tabs.map((tab) => (
                      <Tab key={tab} value={tab}>
                        {TAB_LABELS[tab]}
                      </Tab>
                    ))}
                  </TabsList>
                </Tabs>
                {isPendingReview && !READ_ONLY_TABS.has(effectiveTab) ? (
                  <div className="ml-auto flex items-center gap-2 pr-3">
                    <Button onClick={onResetDraft} size="xs" type="button" variant="secondary">
                      <ButtonLeadIcon icon={EraserIcon} />
                      Reset
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 overflow-hidden">
                {effectiveTab === "structured" && displayed && aiOutput ? (
                  <OutputPanel
                    draft={displayed}
                    editable={isPendingReview}
                    extractionSchema={extractionSchema}
                    hoveredFieldKey={hoveredFieldKey}
                    onChange={onDraftChange}
                    onHoverField={setHoveredFieldKey}
                    original={aiOutput}
                  />
                ) : null}

                {effectiveTab === "markdown" && displayed && markdown !== null ? (
                  <Suspense fallback={<PanelLoading />}>
                    <MarkdownPanel
                      editable={isPendingReview}
                      executionId={executionId}
                      hoveredRegionId={hoveredRegionId}
                      markdown={markdown}
                      onChange={(next) =>
                        onDraftChange(writeFieldValue(displayed, "markdown", next))
                      }
                      onHoverRegion={setHoveredRegionId}
                      tableRegionIds={tableRegionIds}
                      workflow={workflow}
                    />
                  </Suspense>
                ) : null}

                {effectiveTab === "html" && displayed && html !== null ? (
                  <HtmlPanel
                    editable={isPendingReview}
                    html={html}
                    onChange={(next) => onDraftChange(writeFieldValue(displayed, "html", next))}
                  />
                ) : null}

                {effectiveTab === "text" && ocr ? (
                  <Suspense fallback={<PanelLoading />}>
                    <OcrPanel
                      executionId={executionId}
                      hoveredRegionId={hoveredRegionId}
                      ocr={ocr}
                      onHoverRegion={setHoveredRegionId}
                      workflow={workflow}
                    />
                  </Suspense>
                ) : null}

                {effectiveTab === "debug" ? (
                  <DebugPanel
                    extractionSchema={extractionSchema}
                    prompt={state.prompt}
                    schemaName={state.schema_name}
                    validationErrors={state.validation_errors}
                  />
                ) : null}
              </div>
            </div>
          </div>

          {isPendingReview ? (
            <div className="border-default shrink-0 border-t bg-default px-4 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
              {decisionRecorded ? (
                <p className="text-muted flex items-center gap-1.5 text-sm">
                  <CircleNotchIcon aria-hidden className="size-3.5 animate-spin" />
                  Applying the decision…
                </p>
              ) : (
                <>
                  <div className="mb-2 flex items-center gap-2">
                    <span className="size-2.5 shrink-0 rounded-full bg-warning" />
                    <span className="text-default text-sm font-semibold">
                      Review required
                      {state.current_review_step
                        ? ` - ${state.current_review_step.replaceAll("_", " ")}`
                        : ""}
                    </span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      aria-label="Review note"
                      className="flex-1 bg-input text-sm focus:ring-default"
                      onChange={(event) => onNoteChange(event.currentTarget.value)}
                      placeholder="Add a review note (optional)..."
                      type="text"
                      value={note}
                    />
                    {/*
                     * Reject gets the design system's `destructive` variant; Approve has to be dressed
                     * by hand because the system ships no `success` variant. The tokens are the
                     * system's own, so both buttons still follow the theme — this is the narrowest
                     * way to keep the original's green/red decision pair without inventing a variant.
                     */}
                    <Button
                      className="bg-success text-white-default hover:bg-success/90"
                      isDisabled={isSubmitting}
                      onClick={onApprove}
                      type="button"
                    >
                      <ButtonLeadIcon icon={CheckCircleIcon} />
                      Approve
                    </Button>
                    <Button
                      isDisabled={isSubmitting}
                      onClick={onReject}
                      type="button"
                      variant="destructive"
                    >
                      <ButtonLeadIcon icon={XCircleIcon} />
                      Reject
                    </Button>
                  </div>
                </>
              )}
              {submitError ? (
                <p className="mt-1 text-xs text-destructive">
                  {submitError instanceof Error
                    ? submitError.message
                    : "Could not submit the review."}
                </p>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
