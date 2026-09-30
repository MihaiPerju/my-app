import { expect, spyOn, test } from "bun:test";

import type {
  ExtractedDocument,
  OcrDocumentResult,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import capturedOcr from "./fixtures/ocr-citation-layout.json";
import {
  buildOcrRegionIndex,
  getFieldRegions,
  getOcrRegionIdsByLine,
  getReferencedFieldRegions,
} from "./regions";

const textBlock = (content: string) => ({
  type: "text",
  content,
  top_left_x: 0,
  top_left_y: 0,
  bottom_right_x: 1,
  bottom_right_y: 1,
});

test("links every block in a captured OCR response, including tables, images, and repeated text", () => {
  // Match the OCR activity's projection of page markdown and block coordinates into review state.
  const ocr: OcrDocumentResult = {
    ocr_text: capturedOcr.pages.map((page) => page.markdown).join("\n\n---\n\n"),
    page_count: capturedOcr.pages.length,
    pages: capturedOcr.pages.map((page) => ({
      index: page.index,
      width: page.dimensions.width,
      height: page.dimensions.height,
      blocks: page.blocks,
    })),
  };
  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const { regionByLine, mismatch } = getOcrRegionIdsByLine(ocr);
    expect([...regionByLine]).toEqual([
      [1, "p0_b0"],
      [3, "p0_b1"],
      [5, "p0_b2"],
      [7, "p0_b3"],
      [9, "p0_b4"],
      [10, "p0_b4"],
      [12, "p0_b5"],
      [14, "p0_b6"],
      [15, "p0_b6"],
      [16, "p0_b6"],
      [17, "p0_b6"],
      [19, "p0_b7"],
      [21, "p0_b8"],
      [23, "p0_b9"],
      [25, "p0_b10"],
      [29, "p1_b0"],
      [31, "p1_b1"],
      [33, "p1_b2"],
      [35, "p1_b3"],
      [36, "p1_b3"],
      [38, "p1_b4"],
      [40, "p1_b5"],
      [42, "p1_b6"],
    ]);
    expect(mismatch).toBeNull();
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("links every OCR block type by markdown position, including repeated text", () => {
  const ocr: OcrDocumentResult = {
    page_count: 2,
    ocr_text:
      "# Heading\n\n(A) First\n\n(B) Second\n\n| Rate |\n| --- |\n| 10 |\n\nFooter\n\n---\n\nFooter",
    pages: [
      {
        index: 0,
        width: 100,
        height: 200,
        blocks: [
          {
            type: "title",
            content: "# Heading",
            top_left_x: 0,
            top_left_y: 0,
            bottom_right_x: 1,
            bottom_right_y: 1,
          },
          {
            type: "list",
            content: "(A) First\n\n(B) Second",
            top_left_x: 0,
            top_left_y: 0,
            bottom_right_x: 1,
            bottom_right_y: 1,
          },
          {
            type: "table",
            content: "| Rate |\n| --- |\n| 10 |",
            top_left_x: 0,
            top_left_y: 0,
            bottom_right_x: 1,
            bottom_right_y: 1,
          },
          {
            type: "footer",
            content: "Footer",
            top_left_x: 0,
            top_left_y: 0,
            bottom_right_x: 1,
            bottom_right_y: 1,
          },
        ],
      },
      {
        index: 1,
        width: 100,
        height: 200,
        blocks: [
          {
            type: "footer",
            content: "Footer",
            top_left_x: 0,
            top_left_y: 0,
            bottom_right_x: 1,
            bottom_right_y: 1,
          },
        ],
      },
    ],
  };

  expect([...getOcrRegionIdsByLine(ocr).regionByLine]).toEqual([
    [1, "p0_b0"],
    [3, "p0_b1"],
    [4, "p0_b1"],
    [5, "p0_b1"],
    [7, "p0_b2"],
    [8, "p0_b2"],
    [9, "p0_b2"],
    [11, "p0_b3"],
    [15, "p1_b0"],
  ]);
});

test("stops at an OCR block ordering mismatch without linking later repeated text incorrectly", () => {
  const ocr: OcrDocumentResult = {
    page_count: 2,
    ocr_text: "First\n\n---\n\nRepeated",
    pages: [
      {
        index: 0,
        width: 100,
        height: 200,
        blocks: [textBlock("First")],
      },
      {
        index: 1,
        width: 100,
        height: 200,
        blocks: [textBlock("Missing"), textBlock("Repeated")],
      },
    ],
  };

  const warn = spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const { regionByLine, mismatch } = getOcrRegionIdsByLine(ocr);
    expect([...regionByLine]).toEqual([[1, "p0_b0"]]);
    expect(mismatch).toEqual({ pageIndex: 1, blockIndex: 0 });
    expect(warn).not.toHaveBeenCalled();
  } finally {
    warn.mockRestore();
  }
});

test("shows every source-linked OCR region once in document order", () => {
  const ocr: OcrDocumentResult = {
    page_count: 2,
    ocr_text: "First\nSecond\nThird",
    pages: [
      {
        index: 0,
        width: 100,
        height: 200,
        blocks: [
          {
            type: "text",
            content: "First",
            top_left_x: 10,
            top_left_y: 10,
            bottom_right_x: 80,
            bottom_right_y: 30,
          },
          {
            type: "text",
            content: "Second",
            top_left_x: 10,
            top_left_y: 40,
            bottom_right_x: 80,
            bottom_right_y: 60,
          },
        ],
      },
      {
        index: 1,
        width: 100,
        height: 200,
        blocks: [
          {
            type: "text",
            content: "Third",
            top_left_x: 10,
            top_left_y: 10,
            bottom_right_x: 80,
            bottom_right_y: 30,
          },
        ],
      },
    ],
  };
  const extracted: ExtractedDocument = {
    data: { charges: [{ source_label: "First", value: 10 }, { source_label: "Second" }] },
    _sources: {
      "charges.0.source_label": ["source_0"],
      "charges.0.value": ["source_2", "source_0"],
      "charges.1.source_label": ["source_1", "source_bad", "source_99"],
    },
  };

  const index = buildOcrRegionIndex(ocr);
  const regions = getReferencedFieldRegions(index, extracted["_sources"]);

  expect(regions.get(1)?.map((region) => region.id)).toEqual(["p0_b0", "p0_b1"]);
  expect(regions.get(1)?.map((region) => region.label?.regionNumber)).toEqual([1, 2]);
  expect(regions.get(2)?.map((region) => region.id)).toEqual(["p1_b0"]);
  expect(regions.get(2)?.map((region) => region.label?.regionNumber)).toEqual([3]);

  const fieldRegions = getFieldRegions(index, extracted["_sources"], "charges.0.value");
  expect(fieldRegions.get(2)?.map((region) => region.id)).toEqual(["p1_b0"]);
  expect(fieldRegions.get(1)?.map((region) => region.id)).toEqual(["p0_b0"]);
});
