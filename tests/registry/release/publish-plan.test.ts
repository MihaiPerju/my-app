/**
 * `scripts/release/publish-plan.ts`'s `planFor`: routing a flat publish plan (shared tarballs,
 * per-index variants, and per-package required-variant declarations) to the entries a given
 * package registry actually receives, and failing closed when a package is missing a variant a
 * registry needs. Split out of `package-registries.test.ts`, whose other suites exercise the
 * registry-pin projectors and cross-capability registry-state audits, a distinct concern from
 * publish-plan routing.
 */
import { describe, expect, test } from "bun:test";

import {
  DEFAULT_PACKAGE_REGISTRY,
  INTERNAL_PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRY_IDS,
} from "../../../scripts/release/package-registries";
import { planFor, type PlanEntry } from "../../../scripts/release/publish-plan";

describe("publish-plan: planFor", () => {
  // Both halves matter. Dropping a shared tarball ships an incomplete index; carrying another
  // index's variant tells that index's consumers to install from a host they hold no credential
  // for -- the 401 this whole mechanism exists to avoid. Three packages are per-index: the
  // descriptor (`sources`), core (the app's uv index pins, public too), and mistral-design-system
  // (the app's `.npmrc`, internal indexes only).
  test("internal shared artifacts and explicit public artifacts route only to their audience", () => {
    const shared = {
      name: "@mistralai-capabilities/chat",
      version: "1.0.0",
      tarball: "chat.tgz",
    };
    const publicCapability: PlanEntry = {
      name: "@mistralai-capabilities/feature-public",
      version: "1.0.0",
      tarball: "public.tgz",
      registry: "public",
    };
    const plan: PlanEntry[] = [
      shared,
      publicCapability,
      ...PACKAGE_REGISTRY_IDS.map((id) => ({
        name: "@mistralai-capabilities/registry",
        version: "1.0.0",
        tarball: `descriptor/${id}/registry.tgz`,
        registry: id,
      })),
      ...PACKAGE_REGISTRY_IDS.filter((id) => id !== "public").map((id) => ({
        name: "@mistralai-capabilities/base-core",
        version: "1.0.0",
        tarball: `pins/${id}/core.tgz`,
        registry: id,
      })),
      ...INTERNAL_PACKAGE_REGISTRY_IDS.map((id) => ({
        name: "@mistralai-capabilities/feature-mistral-design-system",
        version: "1.0.0",
        tarball: `pins/${id}/mistral-design-system.tgz`,
        registry: id,
        requiredVariants: [...INTERNAL_PACKAGE_REGISTRY_IDS],
      })),
    ];

    for (const id of PACKAGE_REGISTRY_IDS.filter((registryId) => registryId !== "public")) {
      expect(planFor(id, plan).map((entry) => entry.tarball)).toEqual([
        shared.tarball,
        `descriptor/${id}/registry.tgz`,
        `pins/${id}/core.tgz`,
        `pins/${id}/mistral-design-system.tgz`,
      ]);
    }
    expect(planFor("public", plan).map((entry) => entry.tarball)).toEqual([
      publicCapability.tarball,
      "descriptor/public/registry.tgz",
    ]);
  });

  // The failure this guards is asymmetric and silent: a plan that carries a descriptor variant
  // for both indexes but a core variant for only one passes any "has some variant" check, while
  // the other index either misses core entirely or keeps serving the previous release's pins.
  test("a per-index package missing one registry's variant is an error", () => {
    const [first, second] = PACKAGE_REGISTRY_IDS;
    const plan: PlanEntry[] = [
      ...PACKAGE_REGISTRY_IDS.map((id) => ({
        name: "@mistralai-capabilities/registry",
        version: "1.0.0",
        tarball: `descriptor/${id}/registry.tgz`,
        registry: id,
      })),
      {
        name: "@mistralai-capabilities/core",
        version: "1.0.0",
        tarball: `pins/${first}/core.tgz`,
        registry: first,
      },
    ];
    expect(() => planFor(second!, plan)).toThrow("@mistralai-capabilities/core");
    // Descriptor variant + core variant for `first`; this fixture carries no shared tarball.
    expect(planFor(first!, plan)).toHaveLength(2);
  });

  test("an explicit public variant requirement is enforced for the single-registry audience", () => {
    const publicName = "@mistralai-capabilities/feature-public";
    const plan: PlanEntry[] = [
      {
        name: publicName,
        version: "1.0.0",
        tarball: "public.tgz",
        requiredVariants: ["public"],
      },
      ...PACKAGE_REGISTRY_IDS.map((id) => ({
        name: "@mistralai-capabilities/registry",
        version: "1.0.0",
        tarball: `descriptor/${id}/registry.tgz`,
        registry: id,
      })),
    ];

    expect(() => planFor("public", plan)).toThrow(
      `publish plan has no 'public' variant of ${publicName}`,
    );
  });

  // A variant that is packed but not routed anywhere is the silent failure: the index keeps
  // serving whatever stale descriptor it already held and nothing in the release complains. So a
  // plan missing one is an error rather than a shorter upload -- `pack-all.ts` asserts this before
  // it writes the plan, and each publish step re-checks its own id.
  test("a plan with no variant for a registry is an error, not a short upload", () => {
    const plan: PlanEntry[] = [
      {
        name: "@mistralai-capabilities/chat",
        version: "1.0.0",
        tarball: "chat.tgz",
      },
    ];
    expect(() => planFor(DEFAULT_PACKAGE_REGISTRY, plan)).toThrow(/no per-index variants for '.*'/);
  });
});
