import { CircleIcon } from "@phosphor-icons/react";
import { createFileRoute } from "@tanstack/react-router";

import { DocumentReviewPage } from "../../features/document-annotation-ui/components/document-review-page";

export const Route = createFileRoute("/_app/document-annotation-ui")({
  // Claims the landing page, so an app built around document extraction opens on it; a stronger
  // claim (chat's) wins when both are installed.
  staticData: {
    landing: true,
    nav: { label: "Document Extraction", icon: CircleIcon, group: "Apps" },
  },
  component: DocumentAnnotationUiRoute,
});

function DocumentAnnotationUiRoute() {
  return <DocumentReviewPage />;
}
