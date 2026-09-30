import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useMemo,
  useRef,
  useState,
} from "react";
import { flushSync } from "react-dom";
import type { pdfjs } from "react-pdf";

import type { DetectedRegion } from "./detected-region-overlay";

type PDFDocumentProxy = pdfjs.PDFDocumentProxy;

const CONTAINER_PADDING_PX = 16;
const MAX_DEFAULT_ZOOM = 100;

// Browsers silently fail to render canvases exceeding a maximum canvas dimension.
// Mobile (iOS Safari): 8192px. Desktop (Chrome/Firefox/Edge): 16384px.
const MAX_CANVAS_DIMENSION_MOBILE_PX = 8192;
const MAX_CANVAS_DIMENSION_DESKTOP_PX = 16384;

// On image click, scroll slightly above the region to ensure it's visible
const IMAGE_SCROLL_OFFSET = 30;

/** Computes the maximum safe zoom (%) so no page dimension exceeds the browser canvas limit. */
function computeMaxZoom(pageDimensions: Iterable<PageDimensions>, isMobile: boolean): number {
  let maxDimension = 0;
  for (const dims of pageDimensions) {
    maxDimension = Math.max(maxDimension, dims.nativeWidth, dims.nativeHeight);
  }
  if (maxDimension === 0) return Infinity;
  const dpr = typeof window !== "undefined" ? window.devicePixelRatio : 1;
  const maxCanvasPx = isMobile ? MAX_CANVAS_DIMENSION_MOBILE_PX : MAX_CANVAS_DIMENSION_DESKTOP_PX;
  return Math.floor((maxCanvasPx / (maxDimension * dpr)) * 100);
}

/** Computes an element's absolute offset within a scrollable container. */
function getElementOffset(element: HTMLElement, container: HTMLElement) {
  const elementRect = element.getBoundingClientRect();
  const containerRect = container.getBoundingClientRect();
  return {
    top: elementRect.top - containerRect.top + container.scrollTop,
    left: elementRect.left - containerRect.left + container.scrollLeft,
    width: elementRect.width,
    height: elementRect.height,
  };
}

interface PageDimensions {
  nativeWidth: number;
  nativeHeight: number;
}

interface ScaledPageDimensions extends PageDimensions {
  width: number;
  height: number;
  scale: number;
}

type DocumentState =
  | { status: "loading" }
  | { status: "error" }
  | {
      status: "ready";
      pdf: PDFDocumentProxy;
      nativePageDimensionsByPageIndex: Map<number, PageDimensions>;
    };

interface UsePdfViewerProps {
  containerRef: RefObject<HTMLDivElement | null>;
  isMobile?: boolean;
}

interface UsePdfViewerReturn {
  documentState: DocumentState;
  onDocumentLoadSuccess: (pdf: PDFDocumentProxy) => Promise<void>;
  onDocumentLoadError: () => void;
  pageDimensionsByPageIndex: Map<number, ScaledPageDimensions>;
  zoom: number | null;
  maxZoom: number;
  handleZoomChange: (newZoom: number) => void;
  currentPage: number;
  setCurrentPage: Dispatch<SetStateAction<number>>;
  scrollToPage: (pageNumber: number) => void;
  scrollToRegion: (region: DetectedRegion) => void;
  isScrollingRef: RefObject<boolean>;
}

export function usePdfViewer({
  containerRef,
  isMobile = false,
}: UsePdfViewerProps): UsePdfViewerReturn {
  const [documentState, setDocumentState] = useState<DocumentState>({
    status: "loading",
  });

  const [zoom, setZoom] = useState<number | null>(null);

  const [currentPage, setCurrentPage] = useState(1);
  const isScrollingRef = useRef(false);

  const onDocumentLoadSuccess = useCallback(
    async (pdf: PDFDocumentProxy) => {
      try {
        const container = containerRef.current;
        if (!container) {
          return;
        }

        const nativePageDimensionsByPageIndex = new Map<number, PageDimensions>();
        let maxWidth = 0;

        await Promise.all(
          Array.from({ length: pdf.numPages }, async (_, pageIndex) => {
            const page = await pdf.getPage(pageIndex + 1);
            const { width, height } = page.getViewport({ scale: 1 });

            nativePageDimensionsByPageIndex.set(pageIndex, {
              nativeWidth: width,
              nativeHeight: height,
            });

            maxWidth = Math.max(maxWidth, width);
          }),
        );

        const containerWidth = container.clientWidth - CONTAINER_PADDING_PX;
        const fitZoom = Math.floor((containerWidth / maxWidth) * 100);
        const safeMaxZoom = computeMaxZoom(nativePageDimensionsByPageIndex.values(), isMobile);
        const initialZoom = Math.min(fitZoom, MAX_DEFAULT_ZOOM, safeMaxZoom);

        setZoom(initialZoom);
        setDocumentState({
          status: "ready",
          pdf,
          nativePageDimensionsByPageIndex,
        });
        setCurrentPage(1);
      } catch {
        // Handle corrupted PDFs where metadata loads but page data fails
        setDocumentState({ status: "error" });
      }
    },
    [containerRef, isMobile],
  );

  const onDocumentLoadError = useCallback(() => {
    setDocumentState({ status: "error" });
  }, []);

  const maxZoom = useMemo(() => {
    if (documentState.status !== "ready") return Infinity;
    return computeMaxZoom(documentState.nativePageDimensionsByPageIndex.values(), isMobile);
  }, [documentState, isMobile]);

  // Pre-compute all scaled page dimensions to ensure stable references for memoized components
  const pageDimensionsByPageIndex = useMemo(() => {
    if (documentState.status !== "ready" || zoom === null) {
      return new Map<number, ScaledPageDimensions>();
    }

    const map = new Map<number, ScaledPageDimensions>();
    const scale = zoom / 100;

    for (const [pageIndex, dimensions] of documentState.nativePageDimensionsByPageIndex) {
      map.set(pageIndex, {
        width: dimensions.nativeWidth * scale,
        height: dimensions.nativeHeight * scale,
        nativeWidth: dimensions.nativeWidth,
        nativeHeight: dimensions.nativeHeight,
        scale,
      });
    }

    return map;
  }, [documentState, zoom]);

  const handleZoomChange = useCallback(
    (newZoom: number) => {
      const container = containerRef.current;
      if (!container) return;

      const { scrollTop, clientHeight, scrollLeft, clientWidth } = container;

      // Find the current page element to use as anchor
      const anchorPage = container.querySelector<HTMLElement>(`[data-pdf-page="${currentPage}"]`);

      if (!anchorPage) return;

      // Compute fractional offset within the anchor page
      const pageOffset = getElementOffset(anchorPage, container);

      const viewportCenterY = scrollTop + clientHeight / 2;
      const viewportCenterX = scrollLeft + clientWidth / 2;

      const fractionY =
        pageOffset.height > 0 ? (viewportCenterY - pageOffset.top) / pageOffset.height : 0;
      const fractionX =
        pageOffset.width > 0 ? (viewportCenterX - pageOffset.left) / pageOffset.width : 0;

      flushSync(() => setZoom(newZoom));

      // Restore scroll position using the anchor page's updated dimensions
      const newPageOffset = getElementOffset(anchorPage, container);

      container.scrollTop = Math.max(
        0,
        newPageOffset.top + fractionY * newPageOffset.height - container.clientHeight / 2,
      );
      container.scrollLeft = Math.max(
        0,
        newPageOffset.left + fractionX * newPageOffset.width - container.clientWidth / 2,
      );
    },
    [containerRef, currentPage],
  );

  const scrollToPage = useCallback(
    (pageNumber: number) => {
      const pageElement = containerRef.current?.querySelector(`[data-pdf-page="${pageNumber}"]`);
      if (pageElement) {
        // Temporarily disable scroll sync to prevent the IntersectionObserver from
        // updating currentPage with intermediate values during the scroll animation
        isScrollingRef.current = true;

        flushSync(() => setCurrentPage(pageNumber));

        pageElement.scrollIntoView({ behavior: "instant", block: "start" });

        isScrollingRef.current = false;
      }
    },
    [containerRef, isScrollingRef],
  );

  const scrollToRegion = useCallback(
    (region: DetectedRegion) => {
      const container = containerRef.current;
      if (!container) return;

      const pageNumber = region.pageNumber;

      // Ensure the page is rendered (handles virtualization)
      isScrollingRef.current = true;
      flushSync(() => setCurrentPage(pageNumber));

      const pageElement = container.querySelector<HTMLElement>(`[data-pdf-page="${pageNumber}"]`);
      if (!pageElement) {
        isScrollingRef.current = false;
        return;
      }

      const pageDims = pageDimensionsByPageIndex.get(pageNumber - 1);
      if (!pageDims) {
        pageElement.scrollIntoView({ behavior: "instant", block: "start" });
        isScrollingRef.current = false;
        return;
      }

      const coordinateScaleY = pageDims.nativeHeight / region.originalPageHeight;

      const regionTop = region.bounds.topLeftY * coordinateScaleY * pageDims.scale;

      const pageOffset = getElementOffset(pageElement, container);

      const targetScrollTop = pageOffset.top + regionTop - IMAGE_SCROLL_OFFSET;

      container.scrollTo({
        top: Math.max(0, targetScrollTop),
        behavior: "instant",
      });

      isScrollingRef.current = false;
    },
    [containerRef, pageDimensionsByPageIndex, isScrollingRef],
  );

  return {
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
  };
}
