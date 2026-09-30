/**
 * The client-only boundary in front of the vendored viewer.
 *
 * `lazy` plus a mounted flag replaces the original `next/dynamic(..., { ssr: false })`. `lazy` alone
 * still renders during hydration, and this app server-renders every route. `react-pdf`, `pdfjs-dist`
 * and `URL.createObjectURL` need a browser, so the import must wait for one.
 */

import { Suspense, lazy, useEffect, useState, type RefObject } from "react";

import { CircleNotchIcon } from "@phosphor-icons/react";

import type {
  DocumentAnnotationUiWorkflowInfo,
  OcrDocumentResult,
} from "@mistralai-capabilities/feature-document-annotation-ui";
import type { DetectedRegion } from "./document-viewer/index";

const DocumentViewerImpl = lazy(() => import("./document-viewer-impl"));

type WorkflowRoute = Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;

export type DocumentViewerProps = {
  file: File | null;
  fileName: string;
  mimeType: string;
  isFileLoading?: boolean;
  fileError?: unknown;
  ocr: OcrDocumentResult | null;
  executionId: string;
  workflow: WorkflowRoute;
  detectedRegionsByPage: Map<number, DetectedRegion[]>;
  hoveredRegionId: string | null;
  scrollToRegionRef: RefObject<((regionId: string) => void) | null>;
};

function ViewerLoading() {
  return (
    <div className="flex h-full w-full items-center justify-center">
      <CircleNotchIcon aria-hidden className="size-6 animate-spin text-white-muted" />
    </div>
  );
}

export function DocumentViewer(props: DocumentViewerProps) {
  const [isBrowser, setIsBrowser] = useState(false);
  // Hydration is the external boundary: browser-only PDF modules must not render on the server.
  // oxlint-disable-next-line react/set-state-in-effect
  useEffect(() => setIsBrowser(true), []);

  if (!isBrowser) return <ViewerLoading />;

  return (
    <Suspense fallback={<ViewerLoading />}>
      <DocumentViewerImpl {...props} />
    </Suspense>
  );
}
