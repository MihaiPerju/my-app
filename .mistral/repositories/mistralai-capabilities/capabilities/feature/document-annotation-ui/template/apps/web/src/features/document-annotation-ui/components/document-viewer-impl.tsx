/**
 * The real, vendored document viewer — loaded only in the browser.
 *
 * Split out of `document-viewer.tsx` so the lazy boundary keeps this module (with `react-pdf` and
 * `pdfjs-dist`) out of the SSR pass. `pdf-viewer.tsx` sets `pdfjs.GlobalWorkerOptions.workerSrc` at
 * module scope and `image-viewer.tsx` uses `URL.createObjectURL`; neither works on the server.
 */

import { useEffect, useMemo, useState, type RefObject } from "react";

import { Button } from "@mistralai/ui/button";
import { Flex } from "@mistralai/ui/flex";
import { TypographySpan } from "@mistralai/ui/typography";
import { CaretLeftIcon, CaretRightIcon, CircleNotchIcon } from "@phosphor-icons/react";

import type {
  DocumentAnnotationUiWorkflowInfo,
  OcrDocumentResult,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import { useReviewImageQuery } from "../use-document-annotation-ui";
import { ImageViewer, PdfViewer, type DetectedRegion } from "./document-viewer/index";

export type DocumentViewerImplProps = {
  /**
   * The document to render: the reviewer's own upload, or the copy refetched from storage when a
   * review is reopened. `null` only while that fetch is in flight, or when there is nothing to
   * fetch.
   */
  file: File | null;
  fileName: string;
  mimeType: string;
  /** The stored document is on its way — the OCR fallback below would only flash before it lands. */
  isFileLoading?: boolean;
  /** Why the stored document could not be fetched, when it could not. */
  fileError?: unknown;
  ocr: OcrDocumentResult | null;
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  detectedRegionsByPage: Map<number, DetectedRegion[]>;
  hoveredRegionId: string | null;
  scrollToRegionRef: RefObject<((regionId: string) => void) | null>;
};

const PDF_MIME_TYPE = "application/pdf";

function isPdf(file: File | null, mimeType: string): boolean {
  return (file?.type ?? mimeType) === PDF_MIME_TYPE;
}

function isImage(file: File | null, mimeType: string): boolean {
  return (file?.type ?? mimeType).startsWith("image/");
}

function ViewerMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center px-6 text-center">
      <TypographySpan className="text-white-muted" size="sm">
        {children}
      </TypographySpan>
    </div>
  );
}

function ViewerSpinner({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center">
      <CircleNotchIcon aria-hidden className="size-6 animate-spin text-white-muted" />
      <TypographySpan className="text-white-muted" size="sm">
        {children}
      </TypographySpan>
    </div>
  );
}

function documentErrorMessage(cause: unknown): string | null {
  if (cause === null || cause === undefined) return null;
  return cause instanceof Error && cause.message !== ""
    ? cause.message
    : "The stored document could not be loaded.";
}

function imageErrorMessage(cause: unknown, pageNumber: number | undefined): string {
  const pageLabel = pageNumber === undefined ? "this page" : `page ${pageNumber}`;
  return cause instanceof Error && cause.message !== ""
    ? `Could not load ${pageLabel}: ${cause.message}`
    : `Could not load ${pageLabel}.`;
}

/**
 * The page rasters OCR returned, one at a time, when the uploaded file is not in memory.
 *
 * `ImageViewer` renders a single image, so paging is this component's job. Region ids match the PDF
 * path, so a field hover highlights the correct box here.
 */
function OcrPageFallbackViewer({
  ocr,
  executionId,
  workflow,
  detectedRegionsByPage,
  hoveredRegionId,
  fileError,
}: {
  ocr: OcrDocumentResult;
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  detectedRegionsByPage: Map<number, DetectedRegion[]>;
  hoveredRegionId: string | null;
  fileError?: unknown;
}) {
  const [pageSlot, setPageSlot] = useState(0);

  // One entry per page that has an image, tied to its page by `image_ids` (the ids are the OCR
  // API's own, so their order is not page order). Bytes are NOT here — only the id to fetch.
  const pages = useMemo(() => {
    const withImages: Array<{ pageNumber: number; imageId: string }> = [];
    for (const page of ocr.pages ?? []) {
      const imageId = page.image_ids?.[0];
      if (imageId === undefined) continue;
      withImages.push({ pageNumber: page.index + 1, imageId });
    }
    return withImages;
  }, [ocr.pages]);

  // A highlight can point at a page the reviewer is not on; following it is the point of the link.
  const highlightedSlot = useMemo(() => {
    if (hoveredRegionId === null) return undefined;
    for (const [pageNumber, regions] of detectedRegionsByPage) {
      if (!regions.some((region) => region.id === hoveredRegionId)) continue;
      const found = pages.findIndex((page) => page.pageNumber === pageNumber);
      return found >= 0 ? found : undefined;
    }
    return undefined;
  }, [detectedRegionsByPage, hoveredRegionId, pages]);

  useEffect(() => {
    if (highlightedSlot === undefined) return;
    // Region hover is an external navigation event whose selected page persists after pointer exit.
    // oxlint-disable-next-line react/set-state-in-effect
    setPageSlot(highlightedSlot);
  }, [highlightedSlot]);

  const slot = pages.length > 0 ? Math.min(pageSlot, pages.length - 1) : 0;
  const current = pages[slot];

  // Only the page on screen is fetched; react-query caches it, so paging back is instant and a
  // scanned document's rasters never all sit in memory (or in the workflow payload) at once.
  const { data: blob, error: imageError } = useReviewImageQuery(
    workflow,
    executionId,
    current?.imageId ?? null,
  );
  const [file, setFile] = useState<File | null>(null);
  const pageNumber = current?.pageNumber;
  useEffect(() => {
    if (blob === undefined || pageNumber === undefined) {
      // Query/page changes invalidate the previous derived file.
      // oxlint-disable-next-line react/set-state-in-effect
      setFile(null);
      return;
    }
    // The viewer consumes a File and this conversion follows the externally fetched Blob.
    // oxlint-disable-next-line react/set-state-in-effect
    setFile(new File([blob], `page-${pageNumber}.jpg`, { type: blob.type || "image/jpeg" }));
  }, [blob, pageNumber]);

  if (pages.length === 0) {
    const failure = documentErrorMessage(fileError);
    return (
      <ViewerMessage>
        {failure ??
          "This run stored no document and OCR returned no page images, so there is nothing to render."}
      </ViewerMessage>
    );
  }

  const regions = current ? (detectedRegionsByPage.get(current.pageNumber) ?? []) : [];

  return (
    <div className="flex h-full flex-col">
      <Flex alignItems="center" className="shrink-0 px-3 py-2" gap={2} justifyContent="between">
        <TypographySpan className="text-white-muted" size="xs">
          Page {current?.pageNumber ?? slot + 1} of {ocr.page_count}
        </TypographySpan>
        {pages.length > 1 ? (
          <Flex alignItems="center" gap={1}>
            <Button
              aria-label="Previous page"
              icon={CaretLeftIcon}
              isDisabled={slot === 0}
              mode="icon-only"
              onClick={() => setPageSlot(Math.max(slot - 1, 0))}
              size="xs"
              variant="secondary"
            />
            <Button
              aria-label="Next page"
              icon={CaretRightIcon}
              isDisabled={slot >= pages.length - 1}
              mode="icon-only"
              onClick={() => setPageSlot(Math.min(slot + 1, pages.length - 1))}
              size="xs"
              variant="secondary"
            />
          </Flex>
        ) : null}
      </Flex>
      <div className="min-h-0 flex-1 overflow-auto p-3">
        {file ? (
          <ImageViewer detectedRegions={regions} file={file} hoveredRegionId={hoveredRegionId} />
        ) : imageError ? (
          <ViewerMessage>{imageErrorMessage(imageError, current?.pageNumber)}</ViewerMessage>
        ) : (
          <ViewerSpinner>Loading page…</ViewerSpinner>
        )}
      </div>
    </div>
  );
}

export default function DocumentViewerImpl({
  file,
  fileName,
  mimeType,
  isFileLoading = false,
  fileError,
  ocr,
  executionId,
  workflow,
  detectedRegionsByPage,
  hoveredRegionId,
  scrollToRegionRef,
}: DocumentViewerImplProps) {
  const flatRegions = useMemo(
    () => [...detectedRegionsByPage.values()].flat(),
    [detectedRegionsByPage],
  );

  if (file && isPdf(file, mimeType)) {
    return (
      <PdfViewer
        detectedRegionsByPage={detectedRegionsByPage}
        file={file}
        hoveredRegionId={hoveredRegionId}
        scrollToRegionRef={scrollToRegionRef}
      />
    );
  }

  if (file && isImage(file, mimeType)) {
    return (
      <div className="h-full overflow-auto p-3">
        <ImageViewer
          detectedRegions={flatRegions}
          file={file}
          hoveredRegionId={hoveredRegionId}
          labels={{ imageAlt: fileName || "Document preview" }}
        />
      </div>
    );
  }

  // Ahead of the OCR fallback, not after it: the stored document is the better render and it is
  // seconds away, so showing rasters first would swap the page out from under the reviewer.
  if (isFileLoading) {
    return <ViewerSpinner>Loading the document…</ViewerSpinner>;
  }

  if (ocr) {
    return (
      <OcrPageFallbackViewer
        detectedRegionsByPage={detectedRegionsByPage}
        executionId={executionId}
        fileError={fileError}
        hoveredRegionId={hoveredRegionId}
        ocr={ocr}
        workflow={workflow}
      />
    );
  }

  return (
    <ViewerMessage>{documentErrorMessage(fileError) ?? "No document to preview."}</ViewerMessage>
  );
}
