import { useEffect, useState } from "react";

import type { DocumentAnnotationUiWorkflowInfo } from "@mistralai-capabilities/feature-document-annotation-ui";

import { useReviewImageQuery } from "../use-document-annotation-ui";

/**
 * An OCR page image, fetched from object storage and rendered through a short-lived object URL.
 *
 * The review-image route is bearer-authenticated, so the bytes cannot use a plain `<img src>`. They
 * are fetched as a blob (cached, `staleTime: Infinity`) and wrapped in an object URL that is revoked
 * when the blob changes or the image unmounts. Renders nothing until the blob resolves: OCR images
 * are supplementary, so a loading or missing one stays blank instead of a broken image.
 */
export function OcrImage({
  executionId,
  workflow,
  imageId,
  alt,
  className,
}: {
  executionId: string;
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "route_segment"> | null;
  imageId: string;
  alt: string;
  className?: string;
}) {
  const { data: blob } = useReviewImageQuery(workflow, executionId, imageId);
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    if (blob === undefined) {
      // Blob availability is external query state; clear the committed object URL with it.
      // oxlint-disable-next-line react/set-state-in-effect
      setUrl(null);
      return undefined;
    }
    const objectUrl = URL.createObjectURL(blob);
    // Object URLs belong to the committed effect lifecycle so abandoned renders cannot leak them.
    // oxlint-disable-next-line react/set-state-in-effect
    setUrl(objectUrl);
    return () => URL.revokeObjectURL(objectUrl);
  }, [blob]);

  if (url === null) return null;
  return <img alt={alt} className={className} src={url} />;
}
