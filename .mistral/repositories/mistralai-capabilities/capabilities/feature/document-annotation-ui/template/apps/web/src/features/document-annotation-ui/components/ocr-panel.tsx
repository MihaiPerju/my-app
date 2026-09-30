/**
 * The Raw OCR tab: the OCR markdown, with every element linked back to the block it came from.
 *
 * Hovering a rendered element highlights its region in the viewer. Markdown source positions map
 * each rendered block back to the OCR block that supplied those lines, including titles, lists,
 * tables, images, and repeated headers or footers.
 */

import { useEffect, useMemo, useRef } from "react";

import { Markdown, type MarkdownComponents } from "@mistralai/ui/markdown";

import type {
  DocumentAnnotationUiWorkflowInfo,
  OcrDocumentResult,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import { MD_PROSE, isMdastNode, nodeStartLine, ocrImageId } from "./markdown-text";
import { OcrImage } from "./ocr-image";
import { getOcrRegionIdsByLine } from "./regions";

const WRAPPED_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "table",
  "pre",
  "blockquote",
] as const;

type WrappedTag = (typeof WRAPPED_TAGS)[number];

function confidenceColor(percentage: number): string {
  if (percentage >= 95) return "text-success";
  if (percentage >= 80) return "text-warning";
  return "text-destructive";
}

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function ConfidenceBadge({ confidences }: { confidences: ReadonlyArray<number> }) {
  if (confidences.length === 0) return null;

  const average = confidences.reduce((total, value) => total + value, 0) / confidences.length;
  const minimum = Math.min(...confidences);

  return (
    <div className="border-default bg-subtle shrink-0 border-b px-4 py-2">
      <p className="text-default mb-0.5 text-xs font-medium">Page confidence score</p>
      <p className={`text-xs ${confidenceColor(average * 100)}`}>
        Average: {formatPercent(average)}
      </p>
      {confidences.length > 1 ? (
        <p className={`text-xs ${confidenceColor(minimum * 100)}`}>
          Minimum: {formatPercent(minimum)}
        </p>
      ) : null}
    </div>
  );
}

type OcrComponentsParams = {
  regionByLine: ReadonlyMap<number, string>;
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  hoveredRegionId: string | null;
  onHoverRegion: (regionId: string | null) => void;
};

function buildOcrComponents({
  regionByLine,
  executionId,
  workflow,
  hoveredRegionId,
  onHoverRegion,
}: OcrComponentsParams): MarkdownComponents {
  const wrap = (Tag: WrappedTag) =>
    function WrappedElement({
      children,
      node,
      ...props
    }: { children?: React.ReactNode; node?: unknown } & React.HTMLAttributes<HTMLElement>) {
      const line = isMdastNode(node) ? nodeStartLine(node) : undefined;
      const regionId = line === undefined ? undefined : regionByLine.get(line);

      if (regionId === undefined) return <Tag {...props}>{children}</Tag>;

      const isHovered = hoveredRegionId === regionId;
      return (
        <Tag
          {...props}
          className={`${props.className ?? ""} rounded transition-colors ${
            isHovered
              ? "bg-badge-orange ring-1 ring-[var(--border-orange)]"
              : "hover:bg-badge-orange"
          }`.trim()}
          onMouseEnter={() => onHoverRegion(regionId)}
          onMouseLeave={() => onHoverRegion(null)}
        >
          {children}
        </Tag>
      );
    };

  const mapped = Object.fromEntries(WRAPPED_TAGS.map((tag) => [tag, wrap(tag)]));

  return {
    ...mapped,
    img: ({ src, alt }: { src?: string; alt?: string }) => {
      const imageId = ocrImageId(src);
      if (imageId === undefined) return null;
      return (
        <OcrImage
          alt={alt ?? ""}
          className="border-default my-2 max-w-full rounded border"
          executionId={executionId}
          imageId={imageId}
          workflow={workflow}
        />
      );
    },
  };
}

export function OcrPanel({
  ocr,
  executionId,
  workflow,
  hoveredRegionId,
  onHoverRegion,
}: {
  ocr: OcrDocumentResult;
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  hoveredRegionId: string | null;
  onHoverRegion: (regionId: string | null) => void;
}) {
  const { regionByLine, mismatch } = useMemo(() => getOcrRegionIdsByLine(ocr), [ocr]);
  const lastWarnedOcr = useRef<OcrDocumentResult | null>(null);

  useEffect(() => {
    if (mismatch === null || lastWarnedOcr.current === ocr) return;
    lastWarnedOcr.current = ocr;
    console.warn(
      "Raw OCR links stopped: block content was not found in the remaining markdown.",
      mismatch,
    );
  }, [ocr, mismatch]);

  const components = useMemo<MarkdownComponents>(
    () =>
      buildOcrComponents({
        regionByLine,
        executionId,
        workflow,
        hoveredRegionId,
        onHoverRegion,
      }),
    [regionByLine, executionId, workflow, hoveredRegionId, onHoverRegion],
  );

  if (ocr.ocr_text.trim() === "") {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted text-sm">No OCR text.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <ConfidenceBadge confidences={ocr.page_confidences ?? []} />
      <div className={`flex-1 overflow-auto p-4 ${MD_PROSE}`}>
        <Markdown components={components}>{ocr.ocr_text}</Markdown>
      </div>
    </div>
  );
}
