import { describe, expect, test } from "bun:test";

import {
  buildExtractionRequest,
  buildUploadFormData,
  getReferencedRegions,
  getRegionsForField,
  INITIAL_DOCUMENT_FORM,
  isTerminalRunStatus,
  isWithinSizeLimit,
  MAX_DOCUMENT_BYTES,
} from "../src/lib";
import type { ExtractedDocument, OcrDocumentResult, UploadResult } from "../src/types";

/**
 * Two pages, two blocks each. `source_N` is a global block index continuous across pages.
 */
const OCR: OcrDocumentResult = {
  ocr_text: "supplier\nreference\nquantity\namount",
  page_count: 2,
  page_confidences: [0.98, 0.91],
  pages: [
    {
      index: 0,
      width: 1000,
      height: 1400,
      blocks: [
        {
          content: "ACME Corp",
          type: "text",
          top_left_x: 10,
          top_left_y: 20,
          bottom_right_x: 300,
          bottom_right_y: 60,
        },
        {
          content: "Reference REF-42",
          type: "text",
          top_left_x: 10,
          top_left_y: 80,
          bottom_right_x: 320,
          bottom_right_y: 120,
        },
      ],
    },
    {
      index: 1,
      width: 1000,
      height: 1400,
      blocks: [
        {
          content: "Widget  2  10.00  20.00",
          type: "table",
          top_left_x: 40,
          top_left_y: 200,
          bottom_right_x: 960,
          bottom_right_y: 400,
        },
        {
          content: "Amount 20.00",
          type: "text",
          top_left_x: 700,
          top_left_y: 440,
          bottom_right_x: 960,
          bottom_right_y: 480,
        },
      ],
    },
  ],
};

const EXTRACTED: ExtractedDocument = {
  data: {
    title: "ACME Corp",
    reference_no: "REF-42",
    currency: "EUR",
    amount: 20,
    items: [{ description: "Widget", qty: 2, amount: 20 }],
  },
  _sources: {
    title: ["source_0"],
    reference_no: ["source_1"],
    amount: ["source_3"],
    "items.0.amount": ["source_2", "source_3"],
    currency: ["source_99"],
    missing_value: [],
  },
};

const page0 = OCR.pages![0]!;
const page1 = OCR.pages![1]!;

describe("getRegionsForField", () => {
  test("resolves a first-page source to its page index and block", () => {
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "title")).toEqual([
      { page: 0, block: page0.blocks[0]! },
    ]);
  });

  test("resolves a global index that overflows onto a later page", () => {
    // source_3 is the 4th block overall, i.e. page 1's SECOND block — not page 3,
    // and not page 1's block 3.
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "amount")).toEqual([
      { page: 1, block: page1.blocks[1]! },
    ]);
  });

  test("resolves the last block of page 0 and the first block of page 1 contiguously", () => {
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "reference_no")).toEqual([
      { page: 0, block: page0.blocks[1]! },
    ]);
  });

  test("resolves a dot-notation field key with multiple sources, in source order", () => {
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "items.0.amount")).toEqual([
      { page: 1, block: page1.blocks[0]! },
      { page: 1, block: page1.blocks[1]! },
    ]);
  });

  test("skips out-of-range source indices", () => {
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "currency")).toEqual([]);
  });

  test("returns an empty list for an empty or unknown field key", () => {
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "missing_value")).toEqual([]);
    expect(getRegionsForField(OCR, EXTRACTED["_sources"], "not_a_field")).toEqual([]);
  });

  test("returns an empty list when there are no OCR pages", () => {
    const empty: OcrDocumentResult = { ...OCR, page_count: 0, pages: [] };
    expect(getRegionsForField(empty, EXTRACTED["_sources"], "title")).toEqual([]);
  });

  test("ignores malformed source tokens", () => {
    const malformed: ExtractedDocument = {
      ...EXTRACTED,
      // "source_" empty, "nonsense" no prefix, "source_2junk" partial digits — all skipped; only
      // "source_1" resolves. Without the all-digits guard, parseInt would read "2junk" as block 2.
      _sources: { title: ["source_", "nonsense", "source_2junk", "source_1"] },
    };
    expect(getRegionsForField(OCR, malformed["_sources"], "title")).toEqual([
      { page: 0, block: page0.blocks[1]! },
    ]);
  });

  test("falls back to the bare leaf name when no exact dot-path key exists", () => {
    const nested: ExtractedDocument = {
      data: { charges: [{ amount: 20 }] },
      _sources: { amount: ["source_1"] },
    };
    expect(getRegionsForField(OCR, nested["_sources"], "charges.0.amount")).toEqual([
      { page: 0, block: page0.blocks[1]! },
    ]);
  });

  test("does not highlight when neither the exact key nor the leaf is recorded", () => {
    const nested: ExtractedDocument = {
      data: { charges: [{ amount: 20 }] },
      _sources: { "charges.amount": ["source_0"] },
    };
    expect(getRegionsForField(OCR, nested["_sources"], "charges.0.amount")).toEqual([]);
  });
});

describe("getReferencedRegions", () => {
  test("resolves unique citations in document order in one aggregate lookup", () => {
    const extracted: ExtractedDocument = {
      data: {},
      _sources: {
        later: ["source_3", "source_1"],
        duplicate: ["source_1"],
        invalid: ["source_bad", "source_99"],
      },
    };

    expect(getReferencedRegions(OCR, extracted["_sources"])).toEqual([
      { page: 0, block: page0.blocks[1]! },
      { page: 1, block: page1.blocks[1]! },
    ]);
  });
});

test.each([null, undefined, {}])(
  "citation resolvers accept an absent or empty source map: %p",
  (sources) => {
    expect(getRegionsForField(OCR, sources, "title")).toEqual([]);
    expect(getReferencedRegions(OCR, sources)).toEqual([]);
  },
);

describe("buildExtractionRequest", () => {
  test("maps a stored document onto the wire request without inline bytes", () => {
    const upload: UploadResult = {
      document_key: "document_annotation_ui/documents/2f1c/document.pdf",
      file_name: "document.pdf",
      mime_type: "application/pdf",
      size: 4096,
    };

    expect(
      buildExtractionRequest({
        ...INITIAL_DOCUMENT_FORM,
        documentKey: upload.document_key,
        fileName: upload.file_name,
        mimeType: upload.mime_type,
        schemaName: "example",
        promptText: "Read the header first.",
      }),
    ).toEqual({
      document_key: "document_annotation_ui/documents/2f1c/document.pdf",
      file_name: "document.pdf",
      mime_type: "application/pdf",
      schema_name: "example",
      prompt: "Read the header first.",
    });
  });

  test("sends the named document type", () => {
    const request = buildExtractionRequest({
      ...INITIAL_DOCUMENT_FORM,
      documentKey: "document_annotation_ui/documents/2f1c/document.pdf",
      schemaName: "example",
    });

    expect(request.schema_name).toBe("example");
    expect("extraction_schema" in request).toBe(false);
  });

  test("omits a blank prompt so the backend applies its own default", () => {
    const request = buildExtractionRequest({
      ...INITIAL_DOCUMENT_FORM,
      documentKey: "document_annotation_ui/documents/2f1c/document.pdf",
      schemaName: "example",
      promptText: "   ",
    });

    expect(request.prompt).toBeUndefined();
  });

  test("starts from an empty form", () => {
    expect(INITIAL_DOCUMENT_FORM).toEqual({
      documentKey: "",
      fileName: "",
      mimeType: "",
      schemaName: "",
      promptText: "",
    });
  });
});

describe("buildUploadFormData", () => {
  test("puts the file under the `file` field the upload route reads", () => {
    const file = new File([new Uint8Array(8)], "statement.pdf", { type: "application/pdf" });

    const entry = buildUploadFormData(file).get("file");

    expect(entry).toBeInstanceOf(File);
    expect((entry as File).name).toBe("statement.pdf");
  });
});

describe("MAX_DOCUMENT_BYTES", () => {
  test("is the 20MB storage-backed cap, matching the Python schema", () => {
    expect(MAX_DOCUMENT_BYTES).toBe(20 * 1024 * 1024);
  });
});

describe("isWithinSizeLimit", () => {
  test("accepts a file at or under the cap and rejects one over it", () => {
    const under = new File([new Uint8Array(16)], "small.pdf", { type: "application/pdf" });
    const over = new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], "big.pdf", {
      type: "application/pdf",
    });
    expect(isWithinSizeLimit(under)).toBe(true);
    expect(isWithinSizeLimit(over)).toBe(false);
  });
});

describe("isTerminalRunStatus", () => {
  test("treats in-flight and review statuses as non-terminal", () => {
    expect(isTerminalRunStatus("running")).toBe(false);
    expect(isTerminalRunStatus("pending_review")).toBe(false);
    expect(isTerminalRunStatus("retried")).toBe(false);
    expect(isTerminalRunStatus("cancelling")).toBe(false);
  });

  test("treats settled statuses as terminal", () => {
    expect(isTerminalRunStatus("completed")).toBe(true);
    expect(isTerminalRunStatus("rejected")).toBe(true);
    expect(isTerminalRunStatus("failed")).toBe(true);
    expect(isTerminalRunStatus("cancelled")).toBe(true);
  });
});
