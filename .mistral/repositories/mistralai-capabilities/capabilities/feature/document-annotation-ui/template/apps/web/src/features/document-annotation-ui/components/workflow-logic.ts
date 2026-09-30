/**
 * The two decisions the workflow catalog drives, kept out of the components that render them.
 *
 * Which workflow is selected and which output tabs it permits are pure functions of the catalog.
 * They live here, not in a hook, so the page and review screen stay render-only and both rules are
 * unit-testable without React.
 */

import type { DocumentAnnotationUiWorkflowInfo } from "@mistralai-capabilities/feature-document-annotation-ui";

export type OutputTab = "markdown" | "html" | "structured" | "text" | "debug";

export const TAB_LABELS: Record<OutputTab, string> = {
  structured: "Structured Output",
  markdown: "Markdown",
  html: "HTML",
  text: "Raw OCR",
  debug: "Debug",
};

export function isOutputTab(value: string): value is OutputTab {
  return value in TAB_LABELS;
}

/** Tab ORDER, not availability: the review screen drops the ones the run has no data for. */
export const BASE_OUTPUT_TABS: ReadonlyArray<OutputTab> = [
  "markdown",
  "html",
  "structured",
  "text",
];

const DEBUG_OUTPUT_TABS: ReadonlyArray<OutputTab> = [...BASE_OUTPUT_TABS, "debug"];

/**
 * The workflow a name selects, falling back to the first in the catalog.
 *
 * The fallback is what makes the day-1 single-entry catalog need no special case: nothing has been
 * chosen yet, so the only workflow there is IS the choice.
 */
export function resolveSelectedWorkflow(
  workflows: ReadonlyArray<DocumentAnnotationUiWorkflowInfo>,
  selectedName: string | null,
): DocumentAnnotationUiWorkflowInfo | null {
  return workflows.find((workflow) => workflow.name === selectedName) ?? workflows[0] ?? null;
}

/**
 * Gated by the workflow's `show_debug`, declared once in `workflows_catalog.py`; set it `False`
 * there and the Debug tab is gone everywhere, with no web-layer edit.
 *
 * Takes only the field it reads, so the review screen passes the flag it holds as a prop while
 * callers holding a whole `DocumentAnnotationUiWorkflowInfo` pass that.
 */
export function outputTabsFor(
  workflow: Pick<DocumentAnnotationUiWorkflowInfo, "show_debug"> | null,
): ReadonlyArray<OutputTab> {
  return workflow?.show_debug === true ? DEBUG_OUTPUT_TABS : BASE_OUTPUT_TABS;
}
