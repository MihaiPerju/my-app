/**
 * The Extraction tab: every extracted field, editable, linked to the page it was read from.
 *
 * The panel walks `extracted.data`, so it renders whatever the run's resolved schema asked for.
 * Paths are dot-paths (`line_items.0.amount`) because that is the key `_sources` uses. The hovered
 * row path goes straight to `getRegionsForField`.
 */

import { useCallback, useMemo, useState } from "react";

import { CaretDownIcon, EyeIcon, PlusIcon, TrashIcon } from "@phosphor-icons/react";

import type { ExtractedDocument } from "@mistralai-capabilities/feature-document-annotation-ui";

import {
  decodeDocumentData,
  isJsonBoolean,
  isJsonNumber,
  isJsonObject,
  isJsonPrimitive,
  isJsonString,
  type JsonObject,
  type JsonValue,
} from "./json-value";
import type { ExtractionSchema } from "./extraction-schema";

import {
  appendArrayItem,
  deleteFieldValue,
  fieldLabel,
  fieldTitle,
  inputKindForField,
  isFieldEdited,
  parseInputValue,
  readFieldValue,
  toInputValue,
  withSchemaFields,
  writeFieldValue,
  type InputKind,
} from "./field-panel-logic";

const HIDDEN_KEYS = new Set(["_sources", "_tab_name"]);

type FieldEvents = {
  editable: boolean;
  original: ExtractedDocument;
  draft: ExtractedDocument;
  extractionSchema: ExtractionSchema | null;
  hoveredFieldKey: string | null;
  onHoverField: (fieldKey: string | null) => void;
  onFieldChange: (fieldKey: string, value: JsonValue) => void;
  onDeleteField: (fieldKey: string) => void;
  onAddArrayItem: (fieldKey: string) => void;
};

function childPath(basePath: string, segment: string | number): string {
  return basePath === "" ? String(segment) : `${basePath}.${segment}`;
}

function toLabel(key: string): string {
  return key.replaceAll("_", " ").replaceAll(/\b\w/g, (character) => character.toUpperCase());
}

/**
 * A single editable leaf.
 *
 * Long strings get a textarea and numbers get a number input, matching the original: a 400-char
 * address in a one-line input is unreviewable, which is the whole job of this screen.
 */
function EditableLeaf({
  value,
  fieldKey,
  kind,
  onFieldChange,
}: {
  value: JsonValue | undefined;
  fieldKey: string;
  kind: InputKind;
  onFieldChange: (fieldKey: string, value: JsonValue) => void;
}) {
  const text = toInputValue(value);
  // Decide input-vs-textarea ONCE, from the value at mount — deriving it from the live length would
  // swap the element as the reviewer crosses 80 chars, remounting it and dropping keyboard focus.
  const [isMultiline] = useState(() => isJsonString(value) && toInputValue(value).length > 80);

  if (isJsonBoolean(value)) {
    return (
      <select
        className="text-default bg-transparent text-sm focus:outline-none"
        onChange={(event) => onFieldChange(fieldKey, event.currentTarget.value === "true")}
        value={String(value)}
      >
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    );
  }

  if (isJsonString(value) && isMultiline) {
    return (
      <textarea
        className="text-default w-full resize-none bg-transparent text-sm leading-snug focus:outline-none"
        onChange={(event) =>
          onFieldChange(fieldKey, parseInputValue(event.currentTarget.value, value))
        }
        rows={Math.max(2, Math.ceil(text.length / 80))}
        spellCheck={false}
        value={text}
      />
    );
  }

  return (
    <input
      className="text-default w-full bg-transparent text-sm focus:outline-none"
      onChange={(event) =>
        onFieldChange(fieldKey, parseInputValue(event.currentTarget.value, value, kind))
      }
      type={kind === "number" ? "number" : "text"}
      value={text}
    />
  );
}

function FieldContent({
  value,
  fieldKey,
  events,
}: {
  value: JsonValue | undefined;
  fieldKey: string;
  events: FieldEvents;
}) {
  const {
    editable,
    extractionSchema,
    hoveredFieldKey,
    onHoverField,
    onFieldChange,
    onAddArrayItem,
    onDeleteField,
  } = events;

  const isLeafValue =
    value === null || isJsonString(value) || isJsonNumber(value) || isJsonBoolean(value);

  if (editable && isLeafValue) {
    return (
      <EditableLeaf
        fieldKey={fieldKey}
        kind={inputKindForField(extractionSchema, fieldKey, value)}
        onFieldChange={onFieldChange}
        value={value}
      />
    );
  }

  if (value === null || value === undefined) return <span className="text-muted italic">-</span>;
  if (isJsonBoolean(value)) {
    return (
      <span className={value ? "text-success" : "text-destructive"}>{value ? "Yes" : "No"}</span>
    );
  }
  if (isJsonString(value) || isJsonNumber(value)) return <span>{String(value)}</span>;

  if (Array.isArray(value)) {
    if (value.length === 0) {
      return (
        <div>
          <span className="text-muted italic">Empty</span>
          {editable ? (
            <button
              className="text-muted hover:text-default ml-2 inline-flex items-center gap-1 text-xs"
              onClick={() => onAddArrayItem(fieldKey)}
              type="button"
            >
              <PlusIcon aria-hidden className="size-3" />
              Add item
            </button>
          ) : null}
        </div>
      );
    }

    if (value.every(isJsonPrimitive)) {
      // Primitive array items are editable leaves too — a `{ "tags": ["urgent"] }` field must be
      // correctable, removable and add-to-able before approval, and hover-linked to its source block
      // like every other field. Each item is addressed by its index path, the same key the
      // draft/edit/delete helpers and the region overlay use.
      return (
        <div className="space-y-1">
          {value.map((item, index) => {
            const itemKey = childPath(fieldKey, index);
            const isHovered = hoveredFieldKey === itemKey;
            return (
              <div className="flex items-center gap-1" key={itemKey}>
                <div
                  className={`min-w-0 flex-1 rounded px-2 py-1 ${
                    isHovered ? "border border-orange bg-badge-orange" : ""
                  }`}
                  onBlur={() => onHoverField(null)}
                  onFocus={() => onHoverField(itemKey)}
                  onMouseEnter={() => onHoverField(itemKey)}
                  onMouseLeave={() => onHoverField(null)}
                >
                  {editable ? (
                    <EditableLeaf
                      fieldKey={itemKey}
                      kind={inputKindForField(extractionSchema, itemKey, item)}
                      onFieldChange={onFieldChange}
                      value={item}
                    />
                  ) : (
                    <span className="text-sm">{item === null ? "-" : String(item)}</span>
                  )}
                </div>
                {editable ? (
                  <button
                    className="text-muted shrink-0 rounded p-0.5 hover:text-destructive"
                    onClick={() => onDeleteField(itemKey)}
                    title="Remove item"
                    type="button"
                  >
                    <TrashIcon aria-hidden className="size-3" />
                  </button>
                ) : null}
              </div>
            );
          })}
          {editable ? (
            <button
              className="text-muted hover:text-default inline-flex items-center gap-1 text-xs"
              onClick={() => onAddArrayItem(fieldKey)}
              type="button"
            >
              <PlusIcon aria-hidden className="size-3" />
              Add item
            </button>
          ) : null}
        </div>
      );
    }

    return (
      <div className="space-y-2">
        {value.map((item, index) => (
          <CollapsibleCard
            basePath={childPath(fieldKey, index)}
            data={isJsonObject(item) ? item : {}}
            events={events}
            index={index}
            key={childPath(fieldKey, index)}
            onDelete={() => onDeleteField(childPath(fieldKey, index))}
          />
        ))}
        {editable ? (
          <button
            className="text-muted hover:text-default inline-flex items-center gap-1 text-xs"
            onClick={() => onAddArrayItem(fieldKey)}
            type="button"
          >
            <PlusIcon aria-hidden className="size-3" />
            Add item
          </button>
        ) : null}
      </div>
    );
  }

  return (
    <ObjectFields
      basePath={fieldKey}
      data={isJsonObject(value) ? value : {}}
      events={events}
      indent
    />
  );
}

function CollapsibleCard({
  data,
  index,
  basePath,
  events,
  onDelete,
}: {
  data: JsonObject;
  index: number;
  basePath: string;
  events: FieldEvents;
  onDelete: () => void;
}) {
  const [open, setOpen] = useState(true);

  // The first identifying-looking value, so a list of rows reads as its contents rather than as
  // "Item 1..n". Generic on purpose: whichever of these the schema happens to define wins. Only a
  // string or number counts — an object candidate would stringify to "[object Object]".
  const title =
    [data.name, data.id, data.reference, data.title, data.description]
      .map((candidate) =>
        isJsonString(candidate) || isJsonNumber(candidate) ? String(candidate) : "",
      )
      .find((label) => label !== "") ?? `Item ${index + 1}`;

  return (
    <div className="border-default overflow-hidden rounded border">
      <div className="flex items-center">
        <button
          className="text-default hover:bg-subtle flex flex-1 items-center gap-2 px-3 py-1.5 text-left text-sm font-semibold"
          onClick={() => setOpen((previous) => !previous)}
          type="button"
        >
          <CaretDownIcon
            aria-hidden
            className={`text-muted size-3.5 shrink-0 transition-transform ${open ? "" : "-rotate-90"}`}
          />
          <span className="truncate">{title}</span>
        </button>
        {events.editable ? (
          <button
            className="text-muted mr-2 shrink-0 rounded p-0.5 hover:text-destructive"
            onClick={onDelete}
            title="Remove item"
            type="button"
          >
            <TrashIcon aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="border-default border-t px-3 py-2">
          <ObjectFields basePath={basePath} data={data} events={events} />
        </div>
      ) : null}
    </div>
  );
}

function ObjectFields({
  data,
  basePath,
  events,
  indent = false,
}: {
  data: JsonObject;
  basePath: string;
  events: FieldEvents;
  indent?: boolean;
}) {
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(new Set());
  const {
    editable,
    extractionSchema,
    original,
    draft,
    hoveredFieldKey,
    onHoverField,
    onDeleteField,
  } = events;

  const toggleSection = (key: string) =>
    setClosedSections((previous) => {
      const next = new Set(previous);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  return (
    <div className={`space-y-1 overflow-hidden ${indent ? "mt-1 pl-3" : ""}`}>
      {Object.entries(data)
        .filter(([key]) => !HIDDEN_KEYS.has(key))
        .map(([key, value]) => {
          const fieldKey = childPath(basePath, key);
          const isComplex = Array.isArray(value) || isJsonObject(value);

          if (isComplex) {
            const isOpen = !closedSections.has(key);
            return (
              <div key={fieldKey}>
                <div className="flex items-center">
                  <button
                    className="flex flex-1 items-center gap-1.5 py-1"
                    onClick={() => toggleSection(key)}
                    type="button"
                  >
                    <CaretDownIcon
                      aria-hidden
                      className={`text-muted size-4 transition-transform ${isOpen ? "" : "-rotate-90"}`}
                    />
                    <span className="text-default text-sm font-semibold">
                      {fieldTitle(extractionSchema, fieldKey) ?? toLabel(key)}
                    </span>
                  </button>
                  {editable ? (
                    <button
                      className="text-muted shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-destructive [div:hover>&]:opacity-100"
                      onClick={() => onDeleteField(fieldKey)}
                      title="Remove field"
                      type="button"
                    >
                      <TrashIcon aria-hidden className="size-3" />
                    </button>
                  ) : null}
                </div>
                {isOpen ? (
                  <div className="pl-1">
                    <FieldContent events={events} fieldKey={fieldKey} value={value} />
                  </div>
                ) : null}
              </div>
            );
          }

          const isHovered = hoveredFieldKey === fieldKey;
          const edited = editable && isFieldEdited(original, draft, fieldKey);
          const originalValue = edited ? readFieldValue(original, fieldKey) : undefined;
          const originalText =
            originalValue === null || originalValue === undefined
              ? "(empty)"
              : toInputValue(originalValue);

          return (
            <div className="flex items-center gap-1" key={fieldKey}>
              <div
                className={`grid min-w-0 flex-1 items-center gap-x-3 px-2 py-1 ${
                  isHovered ? "rounded border border-orange bg-badge-orange" : ""
                }`}
                onBlur={() => onHoverField(null)}
                onFocus={() => onHoverField(fieldKey)}
                onMouseEnter={() => onHoverField(fieldKey)}
                onMouseLeave={() => onHoverField(null)}
                style={{ gridTemplateColumns: "200px minmax(0, 1fr)" }}
              >
                <span
                  className={`cursor-pointer text-sm font-medium select-none ${
                    isHovered ? "text-warning" : "text-muted hover:text-default"
                  }`}
                  title={fieldLabel(extractionSchema, fieldKey)}
                >
                  {fieldTitle(extractionSchema, fieldKey) ?? toLabel(key)}
                </span>
                <div
                  className={`text-default min-w-0 text-sm ${
                    editable
                      ? `rounded border bg-input px-3 py-1.5 ${isHovered ? "border-orange" : "border-default"} ${
                          edited ? "border-l-2 border-l-warning" : ""
                        }`
                      : ""
                  }`}
                  style={{ overflowWrap: "anywhere" }}
                >
                  <FieldContent events={events} fieldKey={fieldKey} value={value} />
                </div>
              </div>
              {edited ? (
                <span className="group relative shrink-0 cursor-help">
                  <EyeIcon aria-hidden className="size-3.5 text-warning" />
                  <span className="pointer-events-none absolute top-full right-0 z-100 mt-1 hidden rounded bg-inverted px-2 py-1 text-xs whitespace-nowrap text-inverted-default shadow-lg group-hover:block">
                    Original: {originalText}
                  </span>
                </span>
              ) : null}
              {editable ? (
                <button
                  className="text-muted shrink-0 rounded p-0.5 opacity-0 transition-opacity hover:text-destructive [div:hover>&]:opacity-100"
                  onClick={() => onDeleteField(fieldKey)}
                  title="Remove field"
                  type="button"
                >
                  <TrashIcon aria-hidden className="size-3" />
                </button>
              ) : null}
            </div>
          );
        })}
    </div>
  );
}

export function OutputPanel({
  original,
  draft,
  editable,
  extractionSchema,
  onChange,
  hoveredFieldKey,
  onHoverField,
}: {
  original: ExtractedDocument;
  draft: ExtractedDocument;
  editable: boolean;
  extractionSchema: ExtractionSchema | null;
  onChange: (next: ExtractedDocument) => void;
  hoveredFieldKey: string | null;
  onHoverField: (fieldKey: string | null) => void;
}) {
  const onFieldChange = useCallback(
    (fieldKey: string, value: JsonValue) => onChange(writeFieldValue(draft, fieldKey, value)),
    [draft, onChange],
  );
  const onDeleteField = useCallback(
    (fieldKey: string) => onChange(deleteFieldValue(draft, fieldKey)),
    [draft, onChange],
  );
  const onAddArrayItem = useCallback(
    (fieldKey: string) => onChange(appendArrayItem(draft, fieldKey, extractionSchema)),
    [draft, extractionSchema, onChange],
  );

  const events = useMemo<FieldEvents>(
    () => ({
      editable,
      original,
      draft,
      extractionSchema,
      hoveredFieldKey,
      onHoverField,
      onFieldChange,
      onDeleteField,
      onAddArrayItem,
    }),
    [
      editable,
      original,
      draft,
      extractionSchema,
      hoveredFieldKey,
      onHoverField,
      onFieldChange,
      onDeleteField,
      onAddArrayItem,
    ],
  );

  // Render from the schema∪data union, not draft.data alone: a schema-declared field the extraction
  // omitted must still show as an editable null slot so the reviewer can fill it (it is exactly what
  // validation_errors flags). Existing values are untouched.
  const data = useMemo(
    () => withSchemaFields(extractionSchema, decodeDocumentData(draft)),
    [extractionSchema, draft],
  );
  const hasFields = Object.keys(data).some((key) => !HIDDEN_KEYS.has(key));

  if (!hasFields) {
    return (
      <div className="flex h-full items-center justify-center">
        <p className="text-muted text-sm">No data available.</p>
      </div>
    );
  }

  return (
    <div className="h-full overflow-x-hidden overflow-y-auto p-4">
      <ObjectFields basePath="" data={data} events={events} />
    </div>
  );
}
