/**
 * The descriptor v3 contract, asserted against the committed `registry.json` (the
 * published artifact a consuming CLI reads): registry-defined selection kinds,
 * exactly one kind per capability, runtime behaviour expressed only through
 * explicit modules (kind is inert), qualified references, and a required+default
 * selection that satisfies every kind's cardinality.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";

import { readJson, REGISTRY_ROOT } from "../support/template-tree";

interface KindRow {
  id: string;
  title: string;
  description?: string;
  weight: number;
  min: number;
  max?: number;
}
interface CapRow {
  id: string;
  kind: string;
  required?: boolean;
  default?: boolean;
  visible?: boolean;
  module?: { serve: string; route?: string; browser?: boolean };
  dependencies?: string[];
  activatedWhen?: { allOf: string[] };
  compatibility?: Record<string, string[]>;
}
interface DescriptorV3 {
  id: string;
  descriptorVersion: number;
  kinds: KindRow[];
  capabilities: CapRow[];
}

describe("descriptor v3 contract", () => {
  const descriptor = readJson<DescriptorV3>(join(REGISTRY_ROOT, "registry.json"));
  const kindById = new Map(descriptor.kinds.map((kind) => [kind.id, kind]));
  const capById = new Map(descriptor.capabilities.map((cap) => [cap.id, cap]));

  /** The Quick recommendation: required roots + defaults, expanded across the dependency closure. */
  const quickSelection = (): Set<string> => {
    const seen = new Set(
      descriptor.capabilities.filter((cap) => cap.required || cap.default).map((cap) => cap.id),
    );
    const todo = [...seen];
    while (todo.length > 0) {
      const cap = capById.get(todo.pop()!);
      for (const dep of cap?.dependencies ?? []) {
        const id = dep.slice(dep.lastIndexOf("/") + 1);
        if (!seen.has(id)) {
          seen.add(id);
          todo.push(id);
        }
      }
    }
    return seen;
  };

  test("is stamped descriptorVersion 3", () => {
    expect(descriptor.descriptorVersion).toBe(3);
  });

  test("every kind declares a title, integer weight, nonnegative min, and a valid optional max", () => {
    const seen = new Set<string>();
    for (const kind of descriptor.kinds) {
      expect(kind.id, "kind id grammar").toMatch(/^[a-z0-9][a-z0-9._-]*$/);
      expect(seen.has(kind.id), `duplicate kind "${kind.id}"`).toBe(false);
      seen.add(kind.id);
      expect(kind.title.length, `${kind.id}: empty title`).toBeGreaterThan(0);
      expect(Number.isInteger(kind.weight), `${kind.id}: non-integer weight`).toBe(true);
      expect(Number.isInteger(kind.min) && kind.min >= 0, `${kind.id}: bad min`).toBe(true);
      if (kind.max !== undefined) {
        expect(kind.max >= 1 && kind.max >= kind.min, `${kind.id}: bad max`).toBe(true);
      }
    }
  });

  test("kinds are ordered by ascending weight then id", () => {
    const ordered = [...descriptor.kinds].toSorted(
      (a, b) => a.weight - b.weight || a.id.localeCompare(b.id),
    );
    expect(descriptor.kinds.map((kind) => kind.id)).toEqual(ordered.map((kind) => kind.id));
  });

  test("every capability declares exactly one declared kind", () => {
    for (const cap of descriptor.capabilities) {
      expect(cap.kind, `${cap.id}: kind not a string`).toBeTypeOf("string");
      expect(kindById.has(cap.kind), `${cap.id} declares undeclared kind "${cap.kind}"`).toBe(true);
    }
  });

  // The central v3 invariant: `kind` is a pure selection label, so runtime behaviour lives only in
  // `module`. The kind-layout taxonomy legitimately reuses several names that were once runtime
  // roles (base, frontend, backend, feature) AS declared selection groups. What must never return
  // is a historical runtime role that is NOT a declared selection kind — that would smuggle runtime
  // meaning back into `kind`.
  test("no capability carries a historical runtime kind", () => {
    const HISTORICAL_RUNTIME_ROLES = [
      "base",
      "feature",
      "package",
      "frontend",
      "backend",
      "fullstack",
    ];
    const declared = new Set(descriptor.kinds.map((kind) => kind.id));
    const forbidden = new Set(HISTORICAL_RUNTIME_ROLES.filter((role) => !declared.has(role)));
    const offenders = descriptor.capabilities
      .filter((cap) => forbidden.has(cap.kind))
      .map((cap) => `${cap.id}=${cap.kind}`);
    expect(offenders).toEqual([]);
  });

  // Runtime behaviour is expressed exclusively through explicit module declarations,
  // and the migration preserves the v2 role defaults exactly: web (static, "/",
  // browser), api (server, "/api", no browser), workflows (worker, no route/browser).
  test("only the app runtimes declare a module, preserving their serve/route/browser", () => {
    const expected = new Map<string, { serve: string; route?: string; browser?: boolean }>([
      ["fastapi", { serve: "server", route: "/api", browser: false }],
      ["tanstack-start", { serve: "static", route: "/", browser: true }],
      ["workflows", { serve: "worker" }],
    ]);
    for (const cap of descriptor.capabilities) {
      expect(cap.module ?? null, `${cap.id} module`).toEqual(expected.get(cap.id) ?? null);
    }
  });

  // A worker module is off the public router and ships no bundle, so inert route
  // or browser fields are absent, not merely ignored.
  test("worker modules carry no route or browser field", () => {
    for (const cap of descriptor.capabilities) {
      if (cap.module?.serve !== "worker") continue;
      expect(Object.keys(cap.module).toSorted()).toEqual(["serve"]);
    }
  });

  test("every dependency and compatibility reference is a fully qualified id that resolves locally", () => {
    const resolveLocal = (ref: string): string => {
      const [registry, kind, capability, ...rest] = ref.split("/");
      expect(
        rest.length === 0 && registry === descriptor.id && kind !== undefined,
        `unqualified/foreign ref "${ref}"`,
      ).toBe(true);
      const entry = capById.get(capability!);
      expect(entry !== undefined && entry.kind === kind, `dangling ref "${ref}"`).toBe(true);
      return capability!;
    };
    for (const cap of descriptor.capabilities) {
      for (const dep of cap.dependencies ?? []) resolveLocal(dep);
      for (const [kindKey, targets] of Object.entries(cap.compatibility ?? {})) {
        expect(
          kindById.has(kindKey),
          `${cap.id}: compatibility names undeclared kind "${kindKey}"`,
        ).toBe(true);
        for (const target of targets) {
          expect(
            capById.get(resolveLocal(target))?.kind,
            `${cap.id}: compat target "${target}" is not in kind "${kindKey}"`,
          ).toBe(kindKey);
        }
      }
    }
  });

  // Derived capabilities and visibility, asserted on the PUBLISHED descriptor. The freshness test
  // proves registry.json === buildDescriptor, so these hold for whatever integrations the registry
  // ships: activation references stay qualified and locally resolvable, the allOf conjunction is
  // well-formed, no ordinary dependency enters a derived capability, and `visible` only ever
  // serializes as false (the true default is omitted).
  const derivedIds = new Set(
    descriptor.capabilities.filter((cap) => cap.activatedWhen !== undefined).map((cap) => cap.id),
  );

  test("every activatedWhen.allOf reference is a fully qualified id that resolves locally", () => {
    for (const cap of descriptor.capabilities) {
      for (const ref of cap.activatedWhen?.allOf ?? []) {
        const [registry, kind, capability, ...rest] = ref.split("/");
        expect(
          rest.length === 0 && registry === descriptor.id && kind !== undefined,
          `${cap.id}: unqualified/foreign activation ref "${ref}"`,
        ).toBe(true);
        const entry = capById.get(capability!);
        expect(
          entry !== undefined && entry.kind === kind,
          `${cap.id}: dangling activation ref "${ref}"`,
        ).toBe(true);
      }
    }
  });

  test("every derived capability declares a non-empty, unique, self-free allOf", () => {
    for (const cap of descriptor.capabilities) {
      const allOf = cap.activatedWhen?.allOf;
      if (allOf === undefined) continue;
      expect(allOf.length, `${cap.id}: empty allOf`).toBeGreaterThan(0);
      expect(new Set(allOf).size, `${cap.id}: duplicate activation refs`).toBe(allOf.length);
      expect(
        allOf.includes(`${descriptor.id}/${cap.kind}/${cap.id}`),
        `${cap.id}: self-activation`,
      ).toBe(false);
    }
  });

  test("no ordinary dependency targets a derived capability", () => {
    for (const cap of descriptor.capabilities) {
      for (const dep of cap.dependencies ?? []) {
        const target = dep.slice(dep.lastIndexOf("/") + 1);
        expect(
          derivedIds.has(target),
          `${cap.id}: dependency "${dep}" targets derived capability "${target}"`,
        ).toBe(false);
      }
    }
  });

  test("visible is serialized only as false; the true default is never emitted", () => {
    for (const cap of descriptor.capabilities) {
      if ("visible" in cap) {
        expect(cap.visible, `${cap.id}: visible must serialize only as false`).toBe(false);
      }
    }
  });

  // The Quick recommendation must itself be a valid selection: every kind's member
  // count (roots + hidden dependency capabilities) falls within its declared bounds.
  test("required and default roots form a dependency-expanded selection within cardinality", () => {
    const countByKind = new Map<string, number>();
    for (const id of quickSelection()) {
      const kind = capById.get(id)!.kind;
      countByKind.set(kind, (countByKind.get(kind) ?? 0) + 1);
    }
    for (const kind of descriptor.kinds) {
      const n = countByKind.get(kind.id) ?? 0;
      expect(n >= kind.min, `kind "${kind.id}": ${n} selected < min ${kind.min}`).toBe(true);
      if (kind.max !== undefined) {
        expect(n <= kind.max, `kind "${kind.id}": ${n} selected > max ${kind.max}`).toBe(true);
      }
    }
  });

  // A real init smoke path: the Quick selection's app modules derive EXCLUSIVELY from explicit
  // module declarations (as the CLI's appModulesV3 does). The kind-layout default set is web + api
  // + postgres over the required base.
  test("the Quick selection produces exactly the expected app modules", () => {
    const modules = [...quickSelection()]
      .map((id) => capById.get(id)!)
      .filter((cap) => cap.module !== undefined)
      .map((cap) => ({ id: cap.id, ...cap.module! }))
      .toSorted((a, b) => a.id.localeCompare(b.id));
    expect(modules).toEqual([
      { id: "fastapi", serve: "server", route: "/api", browser: false },
      { id: "tanstack-start", serve: "static", route: "/", browser: true },
      { id: "workflows", serve: "worker" },
    ]);
  });

  // The exact non-interactive `mistral apps init --yes` closure: the required base plus every
  // default, dependency-expanded. Pinned so a default flag flip (or a new default capability) is a
  // deliberate edit here, not a silent change to what the standard starter ships. `github-automation`
  // is a default and pulls `code-quality` and `testing`; none of the three adds an app module, so
  // the module assertion above is unaffected.
  test("the Quick selection is exactly the agreed default starter closure", () => {
    expect([...quickSelection()].toSorted()).toEqual([
      "apps",
      "auth",
      "code-quality",
      "core",
      "fastapi",
      "github-automation",
      "mistral-design-system",
      "postgres",
      "tanstack-start",
      "testing",
      "workflows",
    ]);
  });
});
