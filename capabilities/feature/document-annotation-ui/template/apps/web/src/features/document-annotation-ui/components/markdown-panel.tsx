/**
 * The Markdown tab: preview/editor toggle over a markdown-valued extracted field.
 *
 * Rendered only when the run's schema produced one (`extracted.data.markdown` is a string). Each
 * rendered table pairs with a table region by position: the Nth GFM table in the source is the Nth
 * table block OCR found. Position, not text, because the rendered table is reflowed and no longer
 * matches the block byte-for-byte.
 */

import { useMemo, useState } from "react";

import { Tab, Tabs, TabsList } from "@mistralai/ui/tabs";
import { Markdown, type MarkdownComponents } from "@mistralai/ui/markdown";
import { EyeIcon, PencilSimpleIcon } from "@phosphor-icons/react";

import type { DocumentAnnotationUiWorkflowInfo } from "@mistralai-capabilities/feature-document-annotation-ui";

import {
  MD_PROSE,
  findTableHeaderLines,
  isMdastNode,
  nodeStartLine,
  ocrImageId,
} from "./markdown-text";
import { OcrImage } from "./ocr-image";

type ViewMode = "preview" | "editor";

function isViewMode(value: string): value is ViewMode {
  return value === "preview" || value === "editor";
}

type MarkdownComponentsParams = {
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  headerLines: ReadonlyArray<number>;
  tableRegionIds: ReadonlyArray<string>;
  hoveredRegionId: string | null;
  onHoverRegion: (regionId: string | null) => void;
};

function buildMarkdownComponents({
  executionId,
  workflow,
  headerLines,
  tableRegionIds,
  hoveredRegionId,
  onHoverRegion,
}: MarkdownComponentsParams): MarkdownComponents {
  return {
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
    table: ({
      node,
      children,
      ...props
    }: React.TableHTMLAttributes<HTMLTableElement> & { node?: unknown }) => {
      const line = isMdastNode(node) ? nodeStartLine(node) : undefined;
      const rank = line === undefined ? -1 : headerLines.indexOf(line);
      const regionId = rank >= 0 ? tableRegionIds[rank] : undefined;
      const table = <table {...props}>{children}</table>;

      if (regionId === undefined) return table;

      const isHovered = hoveredRegionId === regionId;
      return (
        <div
          className={`-mx-1 rounded px-1 transition-colors ${
            isHovered
              ? "bg-badge-orange ring-1 ring-[var(--border-orange)]"
              : "hover:bg-badge-orange"
          }`}
          onMouseEnter={() => onHoverRegion(regionId)}
          onMouseLeave={() => onHoverRegion(null)}
        >
          {table}
        </div>
      );
    },
  };
}

export function MarkdownPanel({
  markdown,
  editable,
  onChange,
  executionId,
  workflow,
  tableRegionIds,
  hoveredRegionId,
  onHoverRegion,
}: {
  markdown: string;
  editable: boolean;
  onChange: (markdown: string) => void;
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  tableRegionIds: ReadonlyArray<string>;
  hoveredRegionId: string | null;
  onHoverRegion: (regionId: string | null) => void;
}) {
  const [mode, setMode] = useState<ViewMode>("preview");
  const headerLines = useMemo(() => findTableHeaderLines(markdown), [markdown]);

  const components = useMemo<MarkdownComponents>(
    () =>
      buildMarkdownComponents({
        executionId,
        workflow,
        headerLines,
        tableRegionIds,
        hoveredRegionId,
        onHoverRegion,
      }),
    [headerLines, executionId, workflow, tableRegionIds, hoveredRegionId, onHoverRegion],
  );

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-default flex shrink-0 items-center gap-1 border-b px-3 py-1.5">
        <Tabs
          onValueChange={(value) => {
            if (isViewMode(value)) setMode(value);
          }}
          value={mode}
        >
          <TabsList>
            <Tab value="preview">
              <EyeIcon aria-hidden className="mr-1 size-3" />
              Preview
            </Tab>
            <Tab value="editor">
              <PencilSimpleIcon aria-hidden className="mr-1 size-3" />
              Editor
            </Tab>
          </TabsList>
        </Tabs>
      </div>

      {mode === "editor" ? (
        <div className="flex-1 overflow-hidden p-4">
          <textarea
            className="border-default text-default read-only:bg-subtle h-full w-full resize-none rounded border bg-input p-3 text-xs leading-relaxed focus:ring-2 focus:ring-default focus:outline-none"
            onChange={(event) => onChange(event.currentTarget.value)}
            readOnly={!editable}
            spellCheck={false}
            value={markdown}
          />
        </div>
      ) : markdown ? (
        <div className={`flex-1 overflow-auto p-4 ${MD_PROSE}`}>
          <Markdown components={components}>{markdown}</Markdown>
        </div>
      ) : (
        <div className="flex flex-1 items-center justify-center">
          <p className="text-muted text-sm">No markdown output.</p>
        </div>
      )}
    </div>
  );
}
