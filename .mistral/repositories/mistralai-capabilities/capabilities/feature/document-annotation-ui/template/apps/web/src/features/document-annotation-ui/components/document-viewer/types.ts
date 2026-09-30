import type { RefObject } from "react";

import type { DetectedRegion } from "./detected-region-overlay";

export interface PdfViewerToolbarLabels {
  previousPage: string;
  nextPage: string;
  pageNumber: string;
  zoomIn: string;
  zoomOut: string;
  zoomLevel: string;
  showDetectedRegions: string;
  hideDetectedRegions: string;
}

export interface PdfViewerLabels {
  toolbar: PdfViewerToolbarLabels;
  error: {
    title: string;
    description: string;
  };
}

export interface PdfViewerProps {
  file: string | File | Blob;
  detectedRegionsByPage?: Map<number, DetectedRegion[]>;
  hoveredRegionId?: string | null;
  scrollToRegionRef?: RefObject<((regionId: string) => void) | null>;
  isMobile?: boolean;
  labels?: Partial<PdfViewerLabels>;
}
