import { memo } from "react";

import { TypographySpan } from "@mistralai/ui/typography";
import { cn } from "@mistralai/ui/utils";

import { COLOR_SCHEMES, type RegionColorScheme } from "./constants";

export interface DetectedRegion {
  id: string;
  pageNumber: number;
  bounds: {
    topLeftX: number;
    topLeftY: number;
    bottomRightX: number;
    bottomRightY: number;
  };
  label?: {
    regionNumber?: number;
    text: string;
  };
  colorScheme?: RegionColorScheme;
  // Original width & height from API (region coordinates are in this space)
  originalPageWidth: number;
  originalPageHeight: number;
}

interface RegionRectangleProps {
  region: DetectedRegion;
  scale: number;
  coordinateScaleX: number;
  coordinateScaleY: number;
  isHovered?: boolean;
}

const DetectedRegionRectangle = memo(function DetectedRegionRectangle({
  region,
  scale,
  coordinateScaleX,
  coordinateScaleY,
  isHovered,
}: RegionRectangleProps) {
  const { bounds, label, colorScheme = "cyan" } = region;

  // Scale from API coords to page coords, then apply zoom scale
  const position = {
    left: bounds.topLeftX * coordinateScaleX * scale,
    top: bounds.topLeftY * coordinateScaleY * scale,
    width: (bounds.bottomRightX - bounds.topLeftX) * coordinateScaleX * scale,
    height: (bounds.bottomRightY - bounds.topLeftY) * coordinateScaleY * scale,
  };

  const { fill, accent, border, text } = COLOR_SCHEMES[colorScheme];

  return (
    <div
      style={position}
      className={cn(
        "rounded-4 absolute box-border border",
        isHovered ? "bg-brand-400/10 border-brand-400" : [fill, border],
      )}
    >
      {label && (
        <span
          className={cn(
            "rounded-t-4 pointer-events-auto absolute top-0 left-0.5 flex w-max -translate-y-full flex-row items-center gap-x-1 px-1 py-0.5",
            isHovered ? "bg-brand-500" : accent,
          )}
          title={label.text}
        >
          {label.regionNumber !== undefined && (
            <TypographySpan
              variant="subtle"
              size="2xs"
              className={cn(isHovered ? "text-brand-100/50" : [text, "opacity-50"])}
            >
              {label.regionNumber}
            </TypographySpan>
          )}
          <TypographySpan
            variant="subtle"
            size="2xs"
            className={cn(isHovered ? "text-brand-100" : text)}
          >
            {label.text}
          </TypographySpan>
        </span>
      )}
    </div>
  );
});

interface DetectedRegionOverlayProps {
  detectedRegions: DetectedRegion[];
  scale: number;
  pageWidth: number;
  pageHeight: number;
  hoveredRegionId?: string | null;
}

export function DetectedRegionOverlay({
  detectedRegions,
  scale,
  pageWidth,
  pageHeight,
  hoveredRegionId,
}: DetectedRegionOverlayProps) {
  return (
    <div
      className="pointer-events-none absolute top-0 left-0"
      style={{
        width: pageWidth * scale,
        height: pageHeight * scale,
      }}
    >
      {detectedRegions.map((region) => (
        <DetectedRegionRectangle
          key={region.id}
          region={region}
          scale={scale}
          coordinateScaleX={pageWidth / region.originalPageWidth}
          coordinateScaleY={pageHeight / region.originalPageHeight}
          isHovered={hoveredRegionId === region.id}
        />
      ))}
    </div>
  );
}
