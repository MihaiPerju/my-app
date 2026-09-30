import "../../../test/setup.js";

import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, spyOn, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import type { OcrDocumentResult } from "@mistralai-capabilities/feature-document-annotation-ui";

import { OcrPanel } from "./ocr-panel";

const OCR: OcrDocumentResult = {
  page_count: 1,
  ocr_text: "Visible markdown",
  pages: [
    {
      index: 0,
      width: 100,
      height: 200,
      blocks: [
        {
          type: "text",
          content: "Missing block content",
          top_left_x: 0,
          top_left_y: 0,
          bottom_right_x: 1,
          bottom_right_y: 1,
        },
      ],
    },
  ],
};

const PANEL_PROPS = {
  executionId: "test-execution",
  workflow: null,
  hoveredRegionId: null,
  onHoverRegion: () => {},
};

afterEach(cleanup);

test("rendering a mismatch keeps the markdown visible without logging", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const html = renderToStaticMarkup(<OcrPanel {...PANEL_PROPS} ocr={OCR} />);
    expect(html).toContain("Visible markdown");
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("reports each committed OCR mismatch once through Strict Mode and hover rerenders", () => {
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const screen = render(<OcrPanel {...PANEL_PROPS} ocr={OCR} />, { reactStrictMode: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "Raw OCR links stopped: block content was not found in the remaining markdown.",
      { pageIndex: 0, blockIndex: 0 },
    );

    screen.rerender(<OcrPanel {...PANEL_PROPS} hoveredRegionId="p0_b0" ocr={OCR} />);
    expect(warn).toHaveBeenCalledTimes(1);

    screen.rerender(<OcrPanel {...PANEL_PROPS} ocr={{ ...OCR }} />);
    expect(warn).toHaveBeenCalledTimes(2);

    screen.rerender(<OcrPanel {...PANEL_PROPS} ocr={{ ...OCR, pages: [] }} />);
    expect(warn).toHaveBeenCalledTimes(2);
  } finally {
    warn.mockRestore();
  }
});
