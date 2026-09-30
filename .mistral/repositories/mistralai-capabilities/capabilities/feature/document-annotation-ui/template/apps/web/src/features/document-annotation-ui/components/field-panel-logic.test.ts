import { describe, expect, test } from "bun:test";

import {
  getRegionsForField,
  type ExtractedDocument,
  type OcrDocumentResult,
} from "@mistralai-capabilities/feature-document-annotation-ui";

import type { ExtractionSchema } from "./extraction-schema";
import {
  appendArrayItem,
  deleteFieldValue,
  documentFieldKeys,
  editedFieldKeys,
  fieldLabel,
  inputKindForField,
  isFieldEdited,
  parseInputValue,
  readFieldValue,
  toInputValue,
  withSchemaFields,
  writeFieldValue,
} from "./field-panel-logic";
import { isJsonArray, type JsonObject } from "./json-value";

const SCHEMA: ExtractionSchema = {
  type: "object",
  properties: {
    title: { type: "string", title: "Title" },
    amount: { type: "number", title: "Amount" },
    items: {
      type: "array",
      items: {
        type: "object",
        properties: {
          description: { type: "string" },
          amount: { type: "number" },
        },
      },
    },
  },
};

const ORIGINAL: ExtractedDocument = {
  data: {
    title: "ACME Corp",
    amount: 120,
    items: [
      { description: "Widget", amount: 50 },
      { description: "Gadget", amount: 70 },
    ],
  },
  _sources: {
    title: ["source_0"],
    amount: ["source_3"],
    "items.0.amount": ["source_2"],
  },
};

function edit(data: JsonObject): ExtractedDocument {
  return { ...ORIGINAL, data: { ...ORIGINAL.data, ...data } };
}

describe("readFieldValue", () => {
  test("reads scalar and nested dot-path fields", () => {
    expect(readFieldValue(ORIGINAL, "title")).toBe("ACME Corp");
    expect(readFieldValue(ORIGINAL, "items.1.description")).toBe("Gadget");
  });

  test("returns undefined for unknown paths", () => {
    expect(readFieldValue(ORIGINAL, "items.9.amount")).toBeUndefined();
    expect(readFieldValue(ORIGINAL, "items.x.amount")).toBeUndefined();
    expect(readFieldValue(ORIGINAL, "nope")).toBeUndefined();
  });
});

describe("writeFieldValue", () => {
  test("updates nested data without changing provenance", () => {
    const next = writeFieldValue(ORIGINAL, "items.0.amount", 55);
    expect(readFieldValue(next, "items.0.amount")).toBe(55);
    expect(ORIGINAL["_sources"]).toEqual(next["_sources"]);
  });
});

describe("isFieldEdited", () => {
  test("flags changed scalars and nested values", () => {
    expect(isFieldEdited(ORIGINAL, edit({ title: "ACME GmbH" }), "title")).toBe(true);
    const next = writeFieldValue(ORIGINAL, "items.0.amount", 55);
    expect(isFieldEdited(ORIGINAL, next, "items.0.amount")).toBe(true);
  });

  test("does not flag blank values that round-trip as null", () => {
    const original = edit({ optional_note: null });
    expect(isFieldEdited(original, edit({ optional_note: "" }), "optional_note")).toBe(false);
  });
});

describe("documentFieldKeys", () => {
  test("combines schema fields, nested data, and provenance-only keys", () => {
    const keys = documentFieldKeys(SCHEMA, ORIGINAL, ORIGINAL);
    expect(keys).toContain("title");
    expect(keys).toContain("amount");
    expect(keys).toContain("items.0.description");
    expect(keys).toContain("items.1.amount");
  });

  test("includes rows added during review", () => {
    const existingItems = readFieldValue(ORIGINAL, "items");
    const next = edit({
      items: [
        ...(isJsonArray(existingItems) ? existingItems : []),
        { description: "Added", amount: 1 },
      ],
    });
    expect(documentFieldKeys(SCHEMA, ORIGINAL, next)).toContain("items.2.amount");
  });
});

describe("editedFieldKeys", () => {
  test("lists exactly the changed paths", () => {
    const edited = writeFieldValue(edit({ title: "ACME GmbH" }), "items.0.amount", 55);
    expect(editedFieldKeys(SCHEMA, ORIGINAL, edited).toSorted()).toEqual([
      "items.0.amount",
      "title",
    ]);
  });
});

describe("field metadata", () => {
  test("derives labels and input kinds from the schema", () => {
    expect(fieldLabel(SCHEMA, "title")).toBe("Title");
    expect(fieldLabel(SCHEMA, "items.0.amount")).toBe("items › #1 › amount");
    expect(inputKindForField(SCHEMA, "amount", 120)).toBe("number");
    expect(inputKindForField(SCHEMA, "title", "ACME")).toBe("text");
  });
});

describe("input parsing", () => {
  test("turns cleared inputs into null", () => {
    expect(parseInputValue("", "text")).toBeNull();
    expect(parseInputValue("  ", 1)).toBeNull();
  });

  test("parses numbers and keeps text verbatim", () => {
    expect(parseInputValue("12.5", 1)).toBe(12.5);
    expect(parseInputValue("ACME  Corp", "ACME")).toBe("ACME  Corp");
  });

  test("renders empty and structured values for controlled inputs", () => {
    expect(toInputValue(null)).toBe("");
    expect(toInputValue({ ok: true })).toBe('{"ok":true}');
  });
});

describe("deleteFieldValue", () => {
  test("removes a scalar field", () => {
    const next = deleteFieldValue(ORIGINAL, "title");
    expect(readFieldValue(next, "title")).toBeUndefined();
    expect(readFieldValue(next, "amount")).toBe(120);
  });

  test("splices array elements rather than leaving a hole, so later indices shift down", () => {
    const next = deleteFieldValue(ORIGINAL, "items.0");
    expect(readFieldValue(next, "items")).toHaveLength(1);
    // "Gadget" was items.1; after the splice the dot-path that reaches it must be items.0.
    expect(readFieldValue(next, "items.0.description")).toBe("Gadget");
  });

  test("leaves the document alone for paths that do not exist", () => {
    expect(deleteFieldValue(ORIGINAL, "items.9").data).toEqual(ORIGINAL.data);
    expect(deleteFieldValue(ORIGINAL, "nope").data).toEqual(ORIGINAL.data);
  });

  test("primitive array items edit and splice by their index path, like the panel now drives them", () => {
    const doc: ExtractedDocument = { data: { tags: ["urgent", "finance", "q3"] }, _sources: {} };

    const edited = writeFieldValue(doc, "tags.0", "URGENT");
    expect(readFieldValue(edited, "tags")).toEqual(["URGENT", "finance", "q3"]);

    const spliced = deleteFieldValue(doc, "tags.1");
    expect(readFieldValue(spliced, "tags")).toEqual(["urgent", "q3"]);
  });

  test("deleting an array row drops its sources and shifts later rows' sources down", () => {
    const doc: ExtractedDocument = {
      data: { items: [{ amount: 1 }, { amount: 2 }, { amount: 3 }] },
      _sources: {
        "items.0.amount": ["source_0"],
        "items.1.amount": ["source_1"],
        "items.2.amount": ["source_2"],
      },
    };
    const next = deleteFieldValue(doc, "items.0");
    expect(next["_sources"]).toEqual({
      "items.0.amount": ["source_1"],
      "items.1.amount": ["source_2"],
    });
  });

  test("deleting an object field drops its source subtree", () => {
    const doc: ExtractedDocument = {
      data: { supplier: { name: "ACME" }, total: 10 },
      _sources: { "supplier.name": ["source_0"], total: ["source_1"] },
    };
    const next = deleteFieldValue(doc, "supplier");
    expect(next["_sources"]).toEqual({ total: ["source_1"] });
  });
});

describe("appendArrayItem", () => {
  test("shapes a new row from the keys already in the array, with empty values", () => {
    const next = appendArrayItem(ORIGINAL, "items");
    expect(readFieldValue(next, "items")).toHaveLength(3);
    expect(readFieldValue(next, "items.2")).toEqual({ description: null, amount: null });
  });

  test("appends null to an array of primitives", () => {
    const withTags = writeFieldValue(ORIGINAL, "tags", ["a"]);
    expect(readFieldValue(appendArrayItem(withTags, "tags"), "tags")).toEqual(["a", null]);
  });

  test("creates a schema-shaped row for an omitted array", () => {
    const doc: ExtractedDocument = { data: { title: "Q3" }, _sources: {} };
    const next = appendArrayItem(doc, "items", SCHEMA);
    expect(readFieldValue(next, "items")).toEqual([{ description: null, amount: null }]);
  });

  test("uses the item schema when existing rows omitted schema fields", () => {
    const doc: ExtractedDocument = { data: { items: [{ description: "Widget" }] }, _sources: {} };
    const next = appendArrayItem(doc, "items", SCHEMA);
    expect(readFieldValue(next, "items")).toEqual([
      { description: "Widget" },
      { description: null, amount: null },
    ]);
  });

  test("is a no-op when the path is not an array", () => {
    expect(appendArrayItem(ORIGINAL, "title").data).toEqual(ORIGINAL.data);
  });
});

/**
 * The hovered row's key is handed straight to `getRegionsForField`, so the panel's path spelling
 * IS the `_sources` key convention: 0-based numeric index, dot-joined, no brackets. These pin
 * that contract from both ends — a row the panel would render must light the page.
 */
describe("array row keys are the provenance key convention", () => {
  const CHARGES: ExtractedDocument = {
    data: { charges: [{ description: "Handling", amount: 20, unit: "TEU" }] },
    _sources: { "charges.0.amount": ["source_0"] },
  };

  const ONE_BLOCK_OCR: OcrDocumentResult = {
    ocr_text: "Handling 20 TEU",
    page_count: 1,
    page_confidences: [0.99],
    pages: [
      {
        index: 0,
        width: 1000,
        height: 1400,
        blocks: [
          {
            content: "Handling 20 TEU",
            type: "table",
            top_left_x: 10,
            top_left_y: 20,
            bottom_right_x: 900,
            bottom_right_y: 200,
          },
        ],
      },
    ],
  };

  test("an array row's leaf is dot-joined with a 0-based index, never bracketed", () => {
    const keys = documentFieldKeys(null, CHARGES, CHARGES);
    expect(keys).toContain("charges.0.amount");
    expect(keys).toContain("charges.0.description");
    expect(keys.some((key) => key.includes("["))).toBe(false);
  });

  test("the key a charges row renders resolves to the block it was read from", () => {
    expect(getRegionsForField(ONE_BLOCK_OCR, CHARGES["_sources"], "charges.0.amount")).toHaveLength(
      1,
    );
  });

  test("a sibling with no provenance of its own stays dark rather than borrowing the row's", () => {
    expect(getRegionsForField(ONE_BLOCK_OCR, CHARGES["_sources"], "charges.0.description")).toEqual(
      [],
    );
  });
});

describe("withSchemaFields", () => {
  const NESTED_SCHEMA: ExtractionSchema = {
    type: "object",
    properties: {
      title: { type: "string" },
      reference_no: { type: "string" },
      vendor: { type: "object", properties: { name: { type: "string" } } },
      line_items: {
        type: "array",
        items: { type: "object", properties: { amount: { type: "number" } } },
      },
    },
  };

  test("materialises a schema field the extraction omitted as an editable null slot", () => {
    const merged = withSchemaFields(NESTED_SCHEMA, { title: "Q3" });
    expect(merged.title).toBe("Q3");
    expect("reference_no" in merged).toBe(true);
    expect(merged.reference_no).toBeNull();
  });

  test("keeps existing values and fills missing nested object fields", () => {
    const merged = withSchemaFields(NESTED_SCHEMA, { vendor: {} });
    expect(merged.vendor).toEqual({ name: null });
  });

  test("materialises an omitted array field as an array, not a scalar null", () => {
    const merged = withSchemaFields(NESTED_SCHEMA, { title: "Q3" });
    expect(merged.line_items).toEqual([]);
  });

  test("leaves a present array untouched", () => {
    const merged = withSchemaFields(NESTED_SCHEMA, { line_items: [{ amount: 5 }] });
    expect(merged.line_items).toEqual([{ amount: 5 }]);
  });

  test("fills missing schema fields inside present array rows", () => {
    const merged = withSchemaFields(NESTED_SCHEMA, { line_items: [{}] });
    expect(merged.line_items).toEqual([{ amount: null }]);
  });

  test("leaves data untouched when there is no schema", () => {
    expect(withSchemaFields(null, { a: 1 })).toEqual({ a: 1 });
  });
});
