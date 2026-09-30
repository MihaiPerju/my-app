/**
 * release/package-registries.ts — the package indexes this registry distributes to, and
 * each consumer-facing read URL. `sources.{ts,py}` in the descriptor sets which
 * index a consumer reads from. The value is per-index because a descriptor that
 * points a consumer at a host it has no credential for fails `bun add` with 401.
 */

/**
 * The languages a descriptor's `sources` block resolves per index.
 * `PackageRegistry` derives from it, so an index that omits a language fails to
 * compile.
 */
export const PACKAGE_REGISTRY_LANGUAGES = ["ts", "py"] as const;

export type PackageRegistryLanguage = (typeof PACKAGE_REGISTRY_LANGUAGES)[number];

/**
 * Where a consumer of a descriptor published to this index installs from:
 * `ts` an npm registry serving `@mistralai-capabilities/*`, `py` a PEP 503
 * simple index serving `mistralai-capabilities-*`, and `pyUser` the HTTP Basic
 * username uv pairs with the pull token against `py`.
 *
 * `pyUser` exists because the two indexes disagree about it and the token alone
 * does not say which to send. npm has no such field: both hosts take a bearer
 * `_authToken` and no username at all.
 */
export type PackageRegistryAudience = "internal" | "public";

export type PackageRegistry = Record<PackageRegistryLanguage, string> & {
  audience: PackageRegistryAudience;
  /** Empty for an anonymous public index. */
  pyUser: string;
  requiresAuth: boolean;
};

export const PACKAGE_REGISTRIES = {
  // The internal alternative. The `mistral apps` CLI special-cases this npm host and injects
  // $GEMFURY_DEPLOY_TOKEN; apps generated before Cloudsmith became the default pin these URLs.
  gemfury: {
    audience: "internal",
    ts: "https://npm-proxy.fury.io/mistralai/",
    py: "https://pypi.fury.io/mistralai/",
    pyUser: "mistralai",
    requiresAuth: true,
  },
  // The default, and the customer distribution channel. Reading it needs an `sdk-distribution`
  // entitlement token, sent as npm's bearer `_authToken` and as uv's Basic-auth password.
  cloudsmith: {
    audience: "internal",
    ts: "https://npm.cloudsmith.io/mistral-ai/sdk-distribution/",
    py: "https://dl.cloudsmith.io/basic/mistral-ai/sdk-distribution/python/simple/",
    // The literal string `token`, not an account name: that is what the
    // `/basic/` endpoint expects opposite an entitlement token or API key.
    // A bot-user credential would put that user's name here instead.
    pyUser: "token",
    requiresAuth: true,
  },
  // Public artifacts are a strict manifest-selected audience. Merely adding
  // these endpoints must never route internal shared/capability tarballs here;
  // pack-all.ts constructs explicit `public` plan entries.
  public: {
    audience: "public",
    ts: "https://registry.npmjs.org/",
    py: "https://pypi.org/simple/",
    pyUser: "",
    requiresAuth: false,
  },
} as const satisfies Record<string, PackageRegistry>;

export type PackageRegistryId = keyof typeof PACKAGE_REGISTRIES;

// SAFETY: `Object.keys` widens to `string[]`, but its argument is the frozen
// `PACKAGE_REGISTRIES` literal, whose keys are exactly `PackageRegistryId`
// (`keyof typeof PACKAGE_REGISTRIES`); no other key can appear at runtime.
export const PACKAGE_REGISTRY_IDS = Object.keys(PACKAGE_REGISTRIES) as PackageRegistryId[];

export const INTERNAL_PACKAGE_REGISTRY_IDS = PACKAGE_REGISTRY_IDS.filter(
  (id) => PACKAGE_REGISTRIES[id].audience === "internal",
);
export type InternalPackageRegistryId = (typeof INTERNAL_PACKAGE_REGISTRY_IDS)[number];

export const PUBLIC_PACKAGE_REGISTRY = "public" satisfies PackageRegistryId;

export function isPackageRegistryId(value: string): value is PackageRegistryId {
  return Object.hasOwn(PACKAGE_REGISTRIES, value);
}

/**
 * The index the committed repo-root `registry.json` and core's committed template point at.
 * Cloudsmith, the channel customers install from; every other index is a per-index pack variant.
 */
export const DEFAULT_PACKAGE_REGISTRY: PackageRegistryId = "cloudsmith";
