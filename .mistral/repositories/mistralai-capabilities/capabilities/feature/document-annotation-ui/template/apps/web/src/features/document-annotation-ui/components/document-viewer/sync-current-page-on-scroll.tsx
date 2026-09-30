"use client";

import { useEffect } from "react";

interface SyncCurrentPageOnScrollProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
  isScrollingRef: React.RefObject<boolean>;
  onPageChange: (page: number) => void;
}

const THRESHOLDS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9, 1];

/**
 * Syncs the current page state with the user's scroll position.
 *
 * An IntersectionObserver detects which page has the most visible height in the scroll container
 * and calls onPageChange with that page number. Pages must have a `data-pdf-page` attribute.
 * Renders nothing; it exists only for this side effect.
 */
export function SyncCurrentPageOnScroll({
  containerRef,
  isScrollingRef,
  onPageChange,
}: SyncCurrentPageOnScrollProps) {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return undefined;

    const visibilityMap = new Map<number, number>();

    const observer = new IntersectionObserver(
      (entries) => {
        if (isScrollingRef.current) return;

        for (const entry of entries) {
          const pageNum = Number(entry.target.getAttribute("data-pdf-page"));
          if (entry.isIntersecting) {
            visibilityMap.set(pageNum, entry.intersectionRect.height);
          } else {
            visibilityMap.delete(pageNum);
          }
        }

        let mostVisiblePage = 0;
        let maxVisibleHeight = 0;
        for (const [pageNum, visibleHeight] of visibilityMap) {
          if (visibleHeight > maxVisibleHeight) {
            mostVisiblePage = pageNum;
            maxVisibleHeight = visibleHeight;
          }
        }

        if (mostVisiblePage) {
          onPageChange(mostVisiblePage);
        }
      },
      {
        root: container,
        threshold: THRESHOLDS,
      },
    );

    const pages = container.querySelectorAll("[data-pdf-page]");
    pages.forEach((page) => observer.observe(page));

    return () => observer.disconnect();
  }, [containerRef, onPageChange, isScrollingRef]);

  return null;
}
