/**
 * Shared static selection/rendering harness for registry source invariants.
 *
 * Selection state is explicit: ordinary roots are user-selected, while derived prerequisites reached
 * through shorthand remain selected transitively. Keeping those sets distinct prevents an activated
 * integration from pulling its prerequisites backward. This is a small manifest graph projection;
 * generated-app E2E remains the authority for CLI resolution and rendering behavior.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { localCapabilityId } from "../../../scripts/shared/capability-identity";
import { type CapabilityManifest, readManifests } from "../../../scripts/shared/manifests";

import {
  capabilityLocalIds,
  contributedPaths,
  identityOf,
  packageScripts,
  parseProjectManifest,
  REGISTRY_ROOT,
  templateDir,
} from "./template-tree";

export { capabilityLocalIds };

/** The parsed manifests, keyed by local id — the canonical model shared with the generators. */
export type Capability = CapabilityManifest;

export const capabilities = new Map<string, Capability>(
  readManifests(REGISTRY_ROOT).map((manifest) => [localCapabilityId(manifest), manifest]),
);
/** Resolve a source selector against a manifest catalog to a canonical local id. */
const localIdIn = (ref: string, manifests: readonly CapabilityManifest[]): string => {
  const segments = ref.split("/");
  if (segments.length === 3) return localIdIn(segments.slice(1).join("/"), manifests);
  if (segments.length === 2) {
    const match = manifests.find(({ kind, id }) => kind === segments[0] && id === segments[1]);
    if (match === undefined) throw new Error(`unknown capability \`${ref}\``);
    return localCapabilityId(match);
  }
  const matches = manifests.filter((capability) => capability.id === ref);
  if (matches.length !== 1) throw new Error(`expected one capability matching \`${ref}\``);
  return localCapabilityId(matches[0]!);
};

/** Resolve a source selector (bare unique id or `kind/id`) to a canonical local id. */
export const toLocalId = (ref: string): string => localCapabilityId(identityOf(ref));

/** Capabilities the CLI always installs, regardless of selection. */
export const required = capabilityLocalIds.filter((id) => capabilities.get(id)?.required);

/**
 * Whether a selection's `present` local-id set satisfies an authored `has "ref"` gate. A `kind/id`
 * ref matches exactly; a bare leaf matches any present capability whose leaf equals it (authored
 * gates are unambiguous in practice, mirroring the CLI's bare-selector resolution).
 */
function hasRef(present: Set<string>, ref: string): boolean {
  if (ref.includes("/")) return present.has(ref);
  for (const local of present) {
    if (local.slice(local.indexOf("/") + 1) === ref) return true;
  }
  return false;
}

/**
 * Resolve our `{{#if (has "X")}}…{{/if}}` / `{{#unless (has "X")}}…{{/unless}}` subset (nesting
 * supported) for a selection.
 */
export function renderHbs(text: string, present: Set<string>): string {
  const OPEN = /\{\{#(if|unless) \(has "([^"]+)"\)\}\}/y;
  const CLOSE = /\{\{\/(if|unless)\}\}/y;
  let out = "";
  const stack: { block: string; on: boolean }[] = [];
  let i = 0;
  while (i < text.length) {
    OPEN.lastIndex = i;
    const open = OPEN.exec(text);
    if (open) {
      const has = hasRef(present, open[2]!);
      stack.push({ block: open[1]!, on: open[1] === "if" ? has : !has });
      i = OPEN.lastIndex;
      continue;
    }
    CLOSE.lastIndex = i;
    const close = CLOSE.exec(text);
    if (close) {
      if (stack.pop()?.block !== close[1]) throw new Error(`unbalanced {{/${close[1]}}}`);
      i = CLOSE.lastIndex;
      continue;
    }
    if (stack.every((frame) => frame.on)) out += text[i]!;
    i += 1;
  }
  if (stack.length !== 0) throw new Error("unclosed {{#if}}");
  return out;
}

/**
 * Static effective set for a source selection. Ordinary dependencies and prerequisites of directly
 * selected derived shorthand are expanded recursively; derived capabilities then activate forward
 * to a fixed point. `selected` remains distinct from `effective`, so automatic activation never
 * reverse-selects prerequisites.
 */
export function resolveSelection(
  selection: readonly string[],
  manifests: readonly CapabilityManifest[],
): Set<string> {
  const byId = new Map(manifests.map((manifest) => [localCapabilityId(manifest), manifest]));
  const resolve = (ref: string) => localIdIn(ref, manifests);
  const selected = new Set(selection.map(resolve));
  const effective = new Set([
    ...selected,
    ...manifests.filter((manifest) => manifest.required).map(localCapabilityId),
  ]);
  const pending = [...effective];
  for (;;) {
    while (pending.length > 0) {
      const id = pending.pop()!;
      const capability = byId.get(id);
      const refs = [
        ...(capability?.dependencies ?? []),
        ...(selected.has(id) ? (capability?.activatedWhen?.allOf ?? []) : []),
      ];
      for (const ref of refs) {
        const local = resolve(ref);
        if (effective.has(local)) continue;
        effective.add(local);
        pending.push(local);
        if (byId.get(local)?.activatedWhen !== undefined) selected.add(local);
      }
    }

    let activated = false;
    for (const [id, capability] of byId) {
      if (effective.has(id)) continue;
      const allOf = capability.activatedWhen?.allOf;
      if (!allOf?.every((ref) => effective.has(resolve(ref)))) continue;
      effective.add(id);
      pending.push(id);
      activated = true;
    }
    if (!activated) return effective;
  }
}

export function closure(selection: string[]): Set<string> {
  return resolveSelection(selection, [...capabilities.values()]);
}
export interface SelectionClosure {
  /** Stable test label describing the installed set, not merely one representative selection. */
  label: string;
  present: Set<string>;
}

function selectionKey(present: Set<string>): string {
  return [...present].toSorted().join(",");
}

/**
 * Every distinct effective set the static manifest model can produce.
 *
 * Conditional templates observe the effective set, so selections that resolve to the same set are
 * equivalent. Add each selectable capability to the already-distinct sets and deduplicate after
 * every step. This includes derived shorthand roots so recursive prerequisite expansion is covered.
 */
export const selectionClosures: SelectionClosure[] = (() => {
  const distinct = new Map<string, Set<string>>();
  const requiredOnly = closure([]);
  distinct.set(selectionKey(requiredOnly), requiredOnly);
  for (const id of capabilityLocalIds) {
    const previous = Array.from(distinct.values());
    for (const present of previous) {
      const next = closure([...present, id]);
      const key = selectionKey(next);
      if (!distinct.has(key)) distinct.set(key, next);
    }
  }
  return [...distinct].map(([key, present]) => ({
    label: key ? `{${key}}` : "(no capabilities)",
    present,
  }));
})();
/**
 * Every file a selection's closure vendors into the generated app (rendered names, `.hbs` resolved).
 *
 * The single model of a generated app's file set: the core-contraction, github-automation and
 * tooling-testing guards all reason about "what an app with this selection contains" through this
 * one implementation rather than static mirrors that could drift.
 */
export function appFiles(selection: string[]): Set<string> {
  const files = new Set<string>();
  for (const id of closure(selection)) {
    for (const path of contributedPaths(id)) files.add(path);
  }
  return files;
}

/**
 * The whole NX command surface (`project:target`) an app with this selection would present: every
 * `project.json` target plus the scripts NX infers from a colocated `package.json` (project.json
 * wins on a name clash), across the selection's closure.
 */
export function appCommands(selection: string[]): string[] {
  const names: string[] = [];
  const present = closure(selection);
  for (const id of present) {
    const paths = new Set(contributedPaths(id));
    for (const rel of paths) {
      if (rel !== "project.json" && !rel.endsWith("/project.json")) continue;
      const source = [rel, `${rel}.hbs`]
        .map((candidate) => join(templateDir(id), candidate))
        .find((candidate) => existsSync(candidate));
      if (source === undefined) throw new Error(`${id}: no source for rendered ${rel}`);
      const { name, targetNames } = parseProjectManifest(
        renderHbs(readFileSync(source, "utf8"), present),
        rel,
      );
      const surface = new Set(targetNames);
      const packageRel = rel.replace(/project\.json$/, "package.json");
      if (paths.has(packageRel)) {
        for (const script of packageScripts(
          readFileSync(join(templateDir(id), packageRel), "utf8"),
        )) {
          surface.add(script);
        }
      }
      for (const target of surface) names.push(`${name}:${target}`);
    }
  }
  return names;
}

/** The capability references a Handlebars template branches on via `{{#if (has "id")}}`. */
export function gatesIn(...texts: string[]): string[] {
  const ids = new Set<string>();
  for (const text of texts)
    for (const [, id] of text.matchAll(/\{\{#(?:if|unless) \(has "([^"]+)"\)\}\}/g)) ids.add(id!);
  return [...ids];
}

/**
 * Project the real dependency-resolved `selectionClosures` onto the local ids a suite can observe,
 * keeping one representative closure per distinct projection.
 *
 * A conditional template only branches on the capabilities it names, so two installed sets that
 * agree on those ids render identically; enumerating both is wasted work. Each suite passes the
 * references its templates gate on — typically `gatesIn(...)` plus any owner ids its assertions
 * read (bare or local) — which are resolved to local ids and used as the observable surface.
 */
export function selectionsObserving(observed: Iterable<string>): SelectionClosure[] {
  const keep = new Set([...observed].map(toLocalId));
  const byProjection = new Map<string, SelectionClosure>();
  for (const { present } of selectionClosures) {
    const projected = [...present].filter((id) => keep.has(id)).toSorted();
    const key = projected.join(",");
    if (byProjection.has(key)) continue;
    byProjection.set(key, {
      label: key ? `{${key}}` : "(no observed capabilities)",
      present,
    });
  }
  return [...byProjection.values()];
}
