/**
 * shared/capability-identity.ts — the pure projections of a kind-qualified
 * capability identity, shared by the descriptor builder, the release scanners,
 * and the docs table so the four cannot disagree about how an identity renders.
 *
 * A capability is identified by a `(kind, id)` pair that is unique within its
 * registry. Its projections are:
 *
 *   - local id            `<kind>/<id>`                       (within a registry)
 *   - unique (full) id    `<registry>/<kind>/<id>`            (globally)
 *   - npm package name    `@<registry>/<kind>-<id>`           (scope preserved)
 *   - python dist name    `<registry>-<kind>-<id>` (PEP 503)  (normalized)
 *
 * The resolver applies the one fixed policy the CLI uses: a reference is a bare
 * leaf `id`, a local `kind/id`, or a full `registry/kind/id`; a bare leaf
 * resolves only when exactly one candidate carries it, a `kind/id` resolves
 * against the local registry, and a full ref for a foreign registry passes
 * through verbatim as an external reference. Malformed, missing-local, and
 * ambiguous references throw.
 */

/** A registry / capability id: lowercase-alphanumeric, dot/underscore/hyphen inside. */
export const ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/;

/** A capability's identity within its registry: its selection `kind` and bare `id`. */
export interface CapabilityIdentity {
  readonly kind: string;
  readonly id: string;
}

/** The registry-local identity `<kind>/<id>` — unique within one registry. */
export function localCapabilityId(identity: CapabilityIdentity): string {
  return `${identity.kind}/${identity.id}`;
}

/** The globally-unique identity `<registry>/<kind>/<id>`. */
export function uniqueCapabilityId(registryId: string, identity: CapabilityIdentity): string {
  return `${registryId}/${identity.kind}/${identity.id}`;
}

/** The convention npm package name — `@<registry>/<kind>-<id>` (npm scope preserved). */
export function npmCapabilityName(registryId: string, identity: CapabilityIdentity): string {
  return `@${registryId}/${identity.kind}-${identity.id}`;
}

/** PEP 503 normalized project name: lowercase, runs of `-`/`_`/`.` collapsed to `-`. */
export function normalizePyDistName(name: string): string {
  return name.toLowerCase().replace(/[-_.]+/g, "-");
}

/**
 * The normalized distribution a built artifact belongs to. Wheel and sdist filenames both start
 * with the escaped distribution name, a hyphen, then the version, so everything before the first
 * hyphen is the name. Takes a bare filename: strip any directory before calling.
 */
export function pyDistNameFromArtifact(filename: string): string {
  const stem = filename.endsWith(".tar.gz")
    ? filename.slice(0, -".tar.gz".length)
    : filename.endsWith(".whl")
      ? filename.slice(0, -".whl".length)
      : "";
  const boundary = stem.indexOf("-");
  if (boundary <= 0) throw new Error(`cannot read a distribution name from ${filename}`);
  return normalizePyDistName(stem.slice(0, boundary));
}

/**
 * The convention PyPI distribution name for a capability —
 * `<registry>-<kind>-<id>`, PEP 503 normalized.
 */
export function pyCapabilityName(registryId: string, identity: CapabilityIdentity): string {
  return normalizePyDistName(`${registryId}-${identity.kind}-${identity.id}`);
}

/** The full ids of `candidates`, sorted, for a resolver error message. */
function sortedFullIds(registryId: string, candidates: readonly CapabilityIdentity[]): string[] {
  return candidates
    .map((candidate) => uniqueCapabilityId(registryId, candidate))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Resolve a source reference to a full `<registry>/<kind>/<id>` identity against
 * the registry's own capabilities. A bare leaf resolves only when unique; a
 * `kind/id` resolves locally; a full ref for THIS registry must name a local
 * capability, while a full ref for a foreign registry is returned verbatim (an
 * external reference this registry does not own). Throws on a malformed,
 * missing-local, or ambiguous reference, naming the input and the sorted local
 * candidates.
 */
export function resolveCapabilityRef(
  ref: string,
  registryId: string,
  capabilities: readonly CapabilityIdentity[],
): string {
  const segments = ref.split("/");
  if (segments.length < 1 || segments.length > 3 || !segments.every((s) => ID_PATTERN.test(s))) {
    throw new Error(
      `invalid capability reference \`${ref}\`: expected \`id\`, \`kind/id\`, or \`registry/kind/id\`.`,
    );
  }

  // A full `registry/kind/id` naming another registry is external — passed through
  // untouched for later composed-catalog resolution, never matched locally.
  if (segments.length === 3 && segments[0] !== registryId) return ref;

  // Segment count picks the matching key: one segment matches a bare leaf on `id`
  // alone (and may be ambiguous across kinds), two or three pin both `kind` and
  // `id` (the trailing pair). One shared tail then reports missing/ambiguous or
  // resolves the single match to its full identity.
  const matches =
    segments.length === 1
      ? capabilities.filter((c) => c.id === segments[0])
      : capabilities.filter((c) => c.kind === segments.at(-2) && c.id === segments.at(-1));

  const [match] = matches;
  if (match === undefined) {
    throw new Error(
      `unknown capability reference \`${ref}\`; known: ${sortedFullIds(registryId, capabilities).join(", ")}.`,
    );
  }
  if (matches.length > 1) {
    throw new Error(
      `ambiguous capability reference \`${ref}\`; use one of: ${sortedFullIds(registryId, matches).join(", ")}.`,
    );
  }
  return uniqueCapabilityId(registryId, match);
}
