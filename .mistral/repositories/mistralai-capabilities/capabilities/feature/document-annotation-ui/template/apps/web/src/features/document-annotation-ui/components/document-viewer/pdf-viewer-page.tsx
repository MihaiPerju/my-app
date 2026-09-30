"use client";

import { memo } from "react";
import { Page } from "react-pdf";

import { type DetectedRegion, DetectedRegionOverlay } from "./detected-region-overlay";

interface PdfPageProps {
  pageIndex: number;
  shouldRenderContent: boolean;
  pageDimensions?: {
    width: number;
    height: number;
    scale: number;
    nativeWidth: number;
    nativeHeight: number;
  };
  pageRegions?: DetectedRegion[];
  showDetectedRegions: boolean;
  onDocumentLoadError: () => void;
  hoveredRegionId?: string | null;
}

// Stable empty array to prevent unnecessary re-renders of memoized page components
const EMPTY_REGIONS: DetectedRegion[] = [];

export const PdfViewerPage = memo(function PdfPage({
  pageIndex,
  shouldRenderContent,
  pageDimensions,
  pageRegions = EMPTY_REGIONS,
  showDetectedRegions,
  onDocumentLoadError,
  hoveredRegionId,
}: PdfPageProps) {
  return (
    <div
      className="bg-default relative"
      data-pdf-page={pageIndex + 1}
      style={{
        width: pageDimensions?.width,
        height: pageDimensions?.height,
      }}
    >
      {/* For virtualization, always render placeholder parent div with fixed height, but only render actual content when needed. */}
      {shouldRenderContent && (
        <>
          <Page
            pageNumber={pageIndex + 1}
            width={pageDimensions?.width}
            onRenderError={onDocumentLoadError}
            loading={
              <div
                className="bg-default"
                style={{
                  width: pageDimensions?.width,
                  height: pageDimensions?.height,
                }}
              />
            }
          />

          {showDetectedRegions && pageDimensions && pageRegions.length > 0 && (
            <DetectedRegionOverlay
              detectedRegions={pageRegions}
              scale={pageDimensions.scale}
              pageWidth={pageDimensions.nativeWidth}
              pageHeight={pageDimensions.nativeHeight}
              hoveredRegionId={hoveredRegionId}
            />
          )}
        </>
      )}
    </div>
  );
});
