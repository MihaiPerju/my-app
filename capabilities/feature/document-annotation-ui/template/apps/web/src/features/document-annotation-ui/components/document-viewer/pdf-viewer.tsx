"use client";

import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";

import { FileXIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Document, pdfjs } from "react-pdf";

import type { DetectedRegion } from "./detected-region-overlay";
import { PdfViewerPage } from "./pdf-viewer-page";
import { PdfViewerToolbar } from "./pdf-viewer-toolbar";
import { PDFJS_DOCUMENT_OPTIONS } from "./pdfjs-document-options";
import { SyncCurrentPageOnScroll } from "./sync-current-page-on-scroll";
import type { PdfViewerLabels, PdfViewerProps } from "./types";
import { usePdfViewer } from "./use-pdf-viewer";

const RENDERED_PAGES_BUFFER = 4;
const EMPTY_DETECTED_REGIONS_BY_PAGE = new Map<number, DetectedRegion[]>();

/**
 * Where pdf.js fetches its parser worker: a path the host app serves, not a bundler-resolved URL.
 * The served copy is `template/apps/web/public/pdf.worker.min.mjs`. pdf.js refuses to pair a worker
 * with a main thread of a different version, so the served worker and the installed `pdfjs-dist`
 * must match. The web app manifest pins `react-pdf` and `pdfjs-dist`; keep those pins, this worker,
 * and the wasm assets in lockstep.
 */
export const PDF_WORKER_SRC = "/pdf.worker.min.mjs";

pdfjs.GlobalWorkerOptions.workerSrc = PDF_WORKER_SRC;

const DEFAULT_LABELS: PdfViewerLabels = {
  toolbar: {
    previousPage: "Previous page",
    nextPage: "Next page",
    pageNumber: "Page number",
    zoomIn: "Zoom in",
    zoomOut: "Zoom out",
    zoomLevel: "Zoom level",
    showDetectedRegions: "Show detected regions",
    hideDetectedRegions: "Hide detected regions",
  },
  error: {
    title: "Unable to load PDF",
    description:
      "The file could not be loaded. It may be corrupted, password-protected, or not a valid PDF document.",
  },
};

export const PdfViewer = ({
  file,
  detectedRegionsByPage = EMPTY_DETECTED_REGIONS_BY_PAGE,
  hoveredRegionId,
  scrollToRegionRef,
  isMobile,
  labels,
}: PdfViewerProps) => {
  const resolvedLabels: PdfViewerLabels = {
    toolbar: { ...DEFAULT_LABELS.toolbar, ...labels?.toolbar },
    error: { ...DEFAULT_LABELS.error, ...labels?.error },
  };

  const [showDetectedRegions, setShowDetectedRegions] = useState(true);
  const hasDetectedRegions = detectedRegionsByPage.size > 0;

  const containerRef = useRef<HTMLDivElement>(null);

  const {
    documentState,
    onDocumentLoadSuccess,
    onDocumentLoadError,
    pageDimensionsByPageIndex,
    zoom,
    maxZoom,
    handleZoomChange,
    currentPage,
    setCurrentPage,
    scrollToPage,
    scrollToRegion,
    isScrollingRef,
  } = usePdfViewer({ containerRef, isMobile });

  const regionById = useMemo(() => {
    const map = new Map<string, DetectedRegion>();
    for (const regions of detectedRegionsByPage.values()) {
      for (const region of regions) {
        map.set(region.id, region);
      }
    }
    return map;
  }, [detectedRegionsByPage]);

  // Register the scroll callback so external code can invoke it directly
  useEffect(() => {
    if (documentState.status !== "ready" || !scrollToRegionRef) return undefined;

    scrollToRegionRef.current = (regionId: string) => {
      const region = regionById.get(regionId);
      if (!region) return;
      scrollToRegion(region);
    };

    return () => {
      scrollToRegionRef.current = null;
    };
  }, [documentState.status, regionById, scrollToRegion, scrollToRegionRef]);

  const hoveredRegion = hoveredRegionId ? regionById.get(hoveredRegionId) : undefined;

  const handleToggleDetectedRegions = useCallback(() => {
    setShowDetectedRegions((prev) => !prev);
  }, []);

  return (
    <div className="relative flex size-full flex-col bg-(--zinc-1000)">
      {documentState.status === "ready" && zoom !== null && (
        <PdfViewerToolbar
          currentPage={currentPage}
          pagesCount={documentState.pdf.numPages}
          onPageChange={scrollToPage}
          zoom={zoom}
          maxZoom={maxZoom}
          onZoomChange={handleZoomChange}
          showDetectedRegions={showDetectedRegions}
          onToggleDetectedRegions={handleToggleDetectedRegions}
          hasDetectedRegions={hasDetectedRegions}
          labels={resolvedLabels.toolbar}
        />
      )}

      <div
        ref={containerRef}
        className="flex size-full flex-1 flex-col gap-2 overflow-x-auto overflow-y-auto"
      >
        <div className="mx-auto h-full min-w-fit">
          {documentState.status === "error" ? (
            <PdfLoadError labels={resolvedLabels.error} />
          ) : (
            <Document
              file={file}
              options={PDFJS_DOCUMENT_OPTIONS}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={onDocumentLoadError}
              className="flex flex-col items-center gap-4"
              onItemClick={({ pageNumber }) => scrollToPage(pageNumber)}
            >
              {documentState.status === "ready" && (
                <>
                  {Array.from({ length: documentState.pdf.numPages }, (_, pageIndex) => {
                    const pageNumber = pageIndex + 1;
                    const pageRegions = detectedRegionsByPage.get(pageNumber);
                    const pageDimensions = pageDimensionsByPageIndex.get(pageIndex);

                    const shouldRenderContent =
                      Math.abs(pageNumber - currentPage) <= RENDERED_PAGES_BUFFER;

                    return (
                      <PdfViewerPage
                        key={pageIndex}
                        pageIndex={pageIndex}
                        shouldRenderContent={shouldRenderContent}
                        pageDimensions={pageDimensions}
                        pageRegions={pageRegions}
                        showDetectedRegions={showDetectedRegions}
                        onDocumentLoadError={onDocumentLoadError}
                        hoveredRegionId={
                          hoveredRegion?.pageNumber === pageNumber ? hoveredRegionId : undefined
                        }
                      />
                    );
                  })}
                  <SyncCurrentPageOnScroll
                    containerRef={containerRef}
                    onPageChange={setCurrentPage}
                    isScrollingRef={isScrollingRef}
                  />
                </>
              )}
            </Document>
          )}
        </div>
      </div>
    </div>
  );
};

function PdfLoadError({ labels }: { labels: PdfViewerLabels["error"] }) {
  return (
    <div className="flex size-full items-center justify-center p-4">
      <div className="flex max-w-3xl flex-col items-center gap-2 text-center">
        <div className="bg-basic-gray-alpha-10 text-icon-white-subtle mb-2 flex size-10 shrink-0 items-center justify-center rounded-lg">
          <FileXIcon className="size-6" />
        </div>
        <div className="text-white-default text-lg font-medium tracking-tight">{labels.title}</div>
        <p className="text-white-muted text-sm">{labels.description}</p>
      </div>
    </div>
  );
}
