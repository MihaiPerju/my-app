"use client";

import { ScanIcon } from "@phosphor-icons/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { Button, ButtonTooltip } from "@mistralai/ui/button";

import { type DetectedRegion, DetectedRegionOverlay } from "./detected-region-overlay";

export interface ImageViewerLabels {
  showDetectedRegions: string;
  hideDetectedRegions: string;
  imageAlt: string;
}

export interface ImageViewerProps {
  file: File;
  detectedRegions?: DetectedRegion[];
  hoveredRegionId?: string | null;
  labels?: Partial<ImageViewerLabels>;
}

interface ImageDimensions {
  naturalWidth: number;
  naturalHeight: number;
  renderedWidth: number;
}

const EMPTY_DETECTED_REGIONS: DetectedRegion[] = [];

const DEFAULT_LABELS: ImageViewerLabels = {
  showDetectedRegions: "Show detected regions",
  hideDetectedRegions: "Hide detected regions",
  imageAlt: "Image preview",
};

export function ImageViewer({
  file,
  detectedRegions = EMPTY_DETECTED_REGIONS,
  hoveredRegionId,
  labels,
}: ImageViewerProps) {
  const resolvedLabels: ImageViewerLabels = {
    ...DEFAULT_LABELS,
    ...labels,
  };

  const [showDetectedRegions, setShowDetectedRegions] = useState(true);
  const hasDetectedRegions = detectedRegions.length > 0;
  const [dimensions, setDimensions] = useState<ImageDimensions | null>(null);
  const imgRef = useRef<HTMLImageElement>(null);

  const handleImageLoad = useCallback((event: React.SyntheticEvent<HTMLImageElement>) => {
    const img = event.currentTarget;
    setDimensions({
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: img.clientWidth,
    });
  }, []);

  const scale = dimensions ? dimensions.renderedWidth / dimensions.naturalWidth : 1;

  const previewUrl = useMemo(() => URL.createObjectURL(file), [file]);

  useEffect(() => {
    return () => {
      URL.revokeObjectURL(previewUrl);
    };
  }, [previewUrl]);

  useEffect(() => {
    const img = imgRef.current;
    if (!img) return undefined;

    const resizeObserver = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;

      const newWidth = entry.contentRect.width;
      setDimensions((prev) => {
        if (!prev || prev.renderedWidth === newWidth) return prev;
        return { ...prev, renderedWidth: newWidth };
      });
    });

    resizeObserver.observe(img);
    return () => resizeObserver.disconnect();
  }, []);

  return (
    <div className="relative">
      {hasDetectedRegions && (
        <div className="pointer-events-none sticky top-0 z-10 flex h-0 justify-end overflow-visible pe-2">
          <Button
            variant="primary"
            size="xs"
            onClick={() => setShowDetectedRegions((prev) => !prev)}
            mode="icon-only"
            icon={ScanIcon}
            aria-label={
              showDetectedRegions
                ? resolvedLabels.hideDetectedRegions
                : resolvedLabels.showDetectedRegions
            }
            className="pointer-events-auto mt-2 h-10 w-10 px-2"
          >
            <ButtonTooltip delayDuration={0}>
              {showDetectedRegions
                ? resolvedLabels.hideDetectedRegions
                : resolvedLabels.showDetectedRegions}
            </ButtonTooltip>
          </Button>
        </div>
      )}
      <div className="relative inline-block">
        <img
          ref={imgRef}
          src={previewUrl}
          className="max-h-full max-w-full object-contain"
          alt={resolvedLabels.imageAlt}
          onLoad={handleImageLoad}
        />
        {showDetectedRegions && dimensions && hasDetectedRegions && (
          <DetectedRegionOverlay
            detectedRegions={detectedRegions}
            scale={scale}
            pageWidth={dimensions.naturalWidth}
            pageHeight={dimensions.naturalHeight}
            hoveredRegionId={hoveredRegionId}
          />
        )}
      </div>
    </div>
  );
}
