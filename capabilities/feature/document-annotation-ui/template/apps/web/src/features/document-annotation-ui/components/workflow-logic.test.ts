import { describe, expect, test } from "bun:test";

import type { DocumentAnnotationUiWorkflowInfo } from "@mistralai-capabilities/feature-document-annotation-ui";

import {
  BASE_OUTPUT_TABS,
  outputTabsFor,
  resolveSelectedWorkflow,
  TAB_LABELS,
} from "./workflow-logic";

function workflow(
  overrides: Partial<DocumentAnnotationUiWorkflowInfo> = {},
): DocumentAnnotationUiWorkflowInfo {
  return {
    name: "document_annotation_ui_document_extraction",
    display_name: "Document Extraction",
    description: "Extracts structured data from uploaded documents.",
    review_step: "extraction_review",
    show_debug: true,
    route_segment: "document",
    ...overrides,
  };
}

const EXTRACTION = workflow();
const CLASSIFICATION = workflow({
  name: "document_annotation_ui_classification",
  display_name: "Classification",
  review_step: "classification_review",
  show_debug: false,
  route_segment: "classification",
});

describe("resolveSelectedWorkflow", () => {
  test("returns the workflow the name selects", () => {
    expect(
      resolveSelectedWorkflow(
        [EXTRACTION, CLASSIFICATION],
        "document_annotation_ui_classification",
      ),
    ).toBe(CLASSIFICATION);
  });

  test("falls back to the first workflow when nothing is selected yet", () => {
    expect(resolveSelectedWorkflow([EXTRACTION, CLASSIFICATION], null)).toBe(EXTRACTION);
  });

  test("falls back to the first workflow when the name is not in the catalog", () => {
    expect(
      resolveSelectedWorkflow([EXTRACTION, CLASSIFICATION], "document_annotation_ui_gone"),
    ).toBe(EXTRACTION);
  });

  // Day-1 the catalog holds exactly one entry, so every selection resolves to it.
  test("resolves a single-entry catalog to that entry regardless of the name", () => {
    expect(resolveSelectedWorkflow([EXTRACTION], null)).toBe(EXTRACTION);
    expect(resolveSelectedWorkflow([EXTRACTION], "document_annotation_ui_gone")).toBe(EXTRACTION);
  });

  test("returns null for an empty catalog", () => {
    expect(resolveSelectedWorkflow([], null)).toBeNull();
    expect(resolveSelectedWorkflow([], "document_annotation_ui_document_extraction")).toBeNull();
  });
});

describe("outputTabsFor", () => {
  const base = [...BASE_OUTPUT_TABS];

  test("appends debug last when the workflow declares show_debug", () => {
    expect([...outputTabsFor(EXTRACTION)]).toEqual([...base, "debug"]);
  });

  test("omits debug when the workflow declares show_debug false", () => {
    expect([...outputTabsFor(CLASSIFICATION)]).toEqual(base);
  });

  test("omits debug when no workflow is resolved", () => {
    expect([...outputTabsFor(null)]).toEqual(base);
  });

  test("leaves the base tabs and their order untouched either way", () => {
    expect(base).toEqual(["markdown", "html", "structured", "text"]);
    expect(outputTabsFor(EXTRACTION).slice(0, base.length)).toEqual(base);
  });

  test("every tab it can return has a label", () => {
    for (const tab of outputTabsFor(EXTRACTION)) {
      expect(TAB_LABELS[tab]).toBeTruthy();
    }
  });
});
