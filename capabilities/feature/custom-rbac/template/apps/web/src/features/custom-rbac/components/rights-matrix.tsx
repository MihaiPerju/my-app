import { Button } from "@mistralai/ui/button";
import { TypographySpan } from "@mistralai/ui/typography";

import type { CatalogItem, Grant, GrantEntry } from "@mistralai-capabilities/feature-custom-rbac";
import { useAccessCatalog, useAccessSchema } from "@mistralai-capabilities/feature-custom-rbac/web";
import { ErrorState } from "@mistralai-capabilities/feature-mistral-design-system/components";

const PAGE = "page";

type GroupSelection = { checked: boolean; indeterminate: boolean };

/** The tri-state of a group of values against a selection: `checked` when every value is granted,
 * `indeterminate` when some but not all are. Drives a page-level select-all over the page value and
 * its tabs. */
function groupSelection(values: string[], selected: Set<string>): GroupSelection {
  if (values.length === 0) return { checked: false, indeterminate: false };
  let count = 0;
  for (const value of values) if (selected.has(value)) count += 1;
  return { checked: count === values.length, indeterminate: count > 0 && count < values.length };
}

/** Apply one read/write toggle to a dimension's grant map. `write` implies `read`; clearing `read`
 * drops the grant. Pure - the caller owns the map snapshot. */
function applyOne(
  map: Map<string, GrantEntry>,
  value: string,
  field: "read" | "write",
  on: boolean,
): void {
  if (field === "read") {
    if (on) map.set(value, { value, write: map.get(value)?.write ?? false });
    else map.delete(value); // write implies read, so clearing read drops the grant
  } else if (on) {
    map.set(value, { value, write: true });
  } else if (map.get(value)) {
    map.set(value, { value, write: false });
  }
}

/** A checkbox that can show the indeterminate ("some, not all") state, which React exposes only via
 * the DOM node, not a prop. Backs a page-level select-all over its tabs. */
function TriCheckbox({
  ariaLabel,
  checked,
  indeterminate,
  disabled,
  onChange,
}: {
  ariaLabel: string;
  checked: boolean;
  indeterminate: boolean;
  disabled: boolean;
  onChange: (on: boolean) => void;
}) {
  return (
    <input
      aria-label={ariaLabel}
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange(event.target.checked)}
      ref={(el) => {
        if (el) el.indeterminate = indeterminate;
      }}
      type="checkbox"
    />
  );
}

/** One value's read + write toggles. `indent` nests it under a page header (tab sub-rows). */
function ValueRow({
  label,
  indent = false,
  readOn,
  writeOn,
  disabled,
  onRead,
  onWrite,
}: {
  label: string;
  indent?: boolean;
  readOn: boolean;
  writeOn: boolean;
  disabled: boolean;
  onRead: (on: boolean) => void;
  onWrite: (on: boolean) => void;
}) {
  return (
    <div className={`flex items-center gap-4 text-sm ${indent ? "pl-5" : ""}`}>
      <label className="flex items-center gap-1.5">
        <input
          aria-label={`Read ${label}`}
          checked={readOn}
          disabled={disabled}
          onChange={(event) => onRead(event.target.checked)}
          type="checkbox"
        />
        <span aria-hidden>read</span>
      </label>
      <label className="flex items-center gap-1.5">
        <input
          aria-label={`Write ${label}`}
          checked={writeOn}
          disabled={disabled}
          onChange={(event) => onWrite(event.target.checked)}
          type="checkbox"
        />
        <span aria-hidden>write</span>
      </label>
      <span className="text-subtle">{label}</span>
    </div>
  );
}

/**
 * The read/write grid for one subject (a user or a team). Columns come from the app's schema
 * (`page` plus its data dimensions); rows are the grantable values from the catalog. The `page`
 * dimension renders as a hierarchy: a page with tabs gets a tri-state select-all cascading
 * read/write over the page value + all its tab values, with the tabs listed as indented sub-rows;
 * pages without tabs (and every data dimension) render flat. Toggling recomputes that whole
 * dimension's grant set and hands it up via `onReplace` (the per-section `PUT .../grants/{dimension}`
 * the API exposes). `write` implies `read`; clearing `read` removes the grant entirely.
 */
export function RightsMatrix({
  grants,
  onReplace,
  pending = false,
}: {
  grants: Grant[];
  onReplace: (dimension: string, entries: GrantEntry[]) => void;
  /** True while a section replacement is in flight. Each toggle sends a whole-dimension snapshot
   * computed from the last fetched grants, so the inputs are disabled until the write lands and
   * refetches - otherwise a second toggle would ship a stale snapshot that discards the first. */
  pending?: boolean;
}) {
  const schema = useAccessSchema();
  const catalog = useAccessCatalog();

  if (schema.error || catalog.error) {
    return (
      <ErrorState error={schema.error ?? catalog.error} title="Could not load rights metadata" />
    );
  }
  if (schema.isPending || catalog.isPending) {
    return (
      <TypographySpan className="text-subtle" size="sm">
        Loading rights…
      </TypographySpan>
    );
  }
  if (!schema.data || !catalog.data) return null;

  const dimensions = [PAGE, ...schema.data.dimensions];
  const tabsByPage = schema.data.tabs ?? {};
  const grantable = (dimension: string) =>
    new Set((catalog.data[dimension] ?? []).map((item) => item.value));
  // Grants whose value (or whole dimension) the catalog no longer lists: still enforced by the API
  // until removed, but not grantable here, so they are surfaced and purged rather than hidden.
  const orphansOf = (dimension: string) => {
    const known = grantable(dimension);
    return grants.filter((g) => g.dimension === dimension && !known.has(g.value));
  };
  const orphanDimensions = [...new Set(grants.map((g) => g.dimension))].filter(
    (dimension) => !dimensions.includes(dimension),
  );

  // Only catalog values are resent: an orphan in the snapshot would make the API reject the whole
  // section, so saving a section also drops its orphans.
  const snapshot = (dimension: string) => {
    const known = grantable(dimension);
    return new Map<string, GrantEntry>(
      grants
        .filter((g) => g.dimension === dimension && known.has(g.value))
        .map((g) => [g.value, { value: g.value, write: g.write }]),
    );
  };

  const toggleMany = (
    dimension: string,
    values: string[],
    field: "read" | "write",
    on: boolean,
  ) => {
    const map = snapshot(dimension);
    for (const value of values) applyOne(map, value, field, on);
    onReplace(dimension, [...map.values()]);
  };

  const toggle = (dimension: string, value: string, field: "read" | "write", on: boolean) =>
    toggleMany(dimension, [value], field, on);

  const renderPages = (items: CatalogItem[]) => {
    const labelOf = new Map(items.map((i) => [i.value, i.label]));
    const tabValues = new Set(Object.values(tabsByPage).flat());
    const pages = items.filter((i) => !tabValues.has(i.value));
    const readSet = new Set(grants.filter((g) => g.dimension === PAGE).map((g) => g.value));
    const writeSet = new Set(
      grants.filter((g) => g.dimension === PAGE && g.write).map((g) => g.value),
    );
    return pages.map((page) => {
      const pageTabs = (tabsByPage[page.value] ?? [])
        .filter((v) => labelOf.has(v))
        .map((v) => ({ value: v, label: labelOf.get(v) ?? v }));
      if (pageTabs.length === 0) {
        return (
          <ValueRow
            disabled={pending}
            key={page.value}
            label={page.label}
            onRead={(on) => toggle(PAGE, page.value, "read", on)}
            onWrite={(on) => toggle(PAGE, page.value, "write", on)}
            readOn={readSet.has(page.value)}
            writeOn={writeSet.has(page.value)}
          />
        );
      }
      const group = [page.value, ...pageTabs.map((t) => t.value)];
      const readState = groupSelection(group, readSet);
      const writeState = groupSelection(group, writeSet);
      return (
        <div className="flex flex-col gap-1.5" key={page.value}>
          <div className="flex items-center gap-4 text-sm font-medium">
            <span className="flex items-center gap-1.5">
              <TriCheckbox
                ariaLabel={`Read all of ${page.label}`}
                checked={readState.checked}
                disabled={pending}
                indeterminate={readState.indeterminate}
                onChange={(on) => toggleMany(PAGE, group, "read", on)}
              />
              <span>read</span>
            </span>
            <span className="flex items-center gap-1.5">
              <TriCheckbox
                ariaLabel={`Write all of ${page.label}`}
                checked={writeState.checked}
                disabled={pending}
                indeterminate={writeState.indeterminate}
                onChange={(on) => toggleMany(PAGE, group, "write", on)}
              />
              <span>write</span>
            </span>
            <span>{page.label}</span>
          </div>
          {pageTabs.map((tab) => (
            <ValueRow
              disabled={pending}
              indent
              key={tab.value}
              label={tab.label}
              onRead={(on) => toggle(PAGE, tab.value, "read", on)}
              onWrite={(on) => toggle(PAGE, tab.value, "write", on)}
              readOn={readSet.has(tab.value)}
              writeOn={writeSet.has(tab.value)}
            />
          ))}
        </div>
      );
    });
  };

  return (
    <div className="flex flex-col gap-3">
      {dimensions.map((dimension) => {
        const items = catalog.data[dimension] ?? [];
        const readSet = new Set(
          grants.filter((g) => g.dimension === dimension).map((g) => g.value),
        );
        const writeSet = new Set(
          grants.filter((g) => g.dimension === dimension && g.write).map((g) => g.value),
        );
        const orphans = orphansOf(dimension);
        return (
          <div className="border-default rounded-lg border p-3" key={dimension}>
            <TypographySpan className="font-medium capitalize">
              {dimension.replaceAll("_", " ")}
            </TypographySpan>
            {orphans.length > 0 ? (
              <div className="text-subtle mt-1 text-sm">
                {`No longer in the catalog, removed on the next change here: ${orphans
                  .map((g) => g.value)
                  .join(", ")}`}
              </div>
            ) : null}
            {items.length === 0 ? (
              <div className="text-subtle mt-1 text-sm">No grantable values.</div>
            ) : (
              <div className="mt-2 grid gap-1.5">
                {dimension === PAGE
                  ? renderPages(items)
                  : items.map((item) => (
                      <ValueRow
                        disabled={pending}
                        key={item.value}
                        label={item.label}
                        onRead={(on) => toggle(dimension, item.value, "read", on)}
                        onWrite={(on) => toggle(dimension, item.value, "write", on)}
                        readOn={readSet.has(item.value)}
                        writeOn={writeSet.has(item.value)}
                      />
                    ))}
              </div>
            )}
          </div>
        );
      })}
      {orphanDimensions.map((dimension) => (
        <div className="border-default rounded-lg border p-3" key={dimension}>
          <TypographySpan className="font-medium capitalize">
            {dimension.replaceAll("_", " ")}
          </TypographySpan>
          <div className="text-subtle mt-1 flex items-center justify-between gap-2 text-sm">
            <span>
              {`This dimension is no longer granted by the app, but these grants still apply: ${grants
                .filter((g) => g.dimension === dimension)
                .map((g) => g.value)
                .join(", ")}`}
            </span>
            <Button
              isDisabled={pending}
              onClick={() => onReplace(dimension, [])}
              size="xs"
              type="button"
              variant="ghost"
            >
              Remove
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
