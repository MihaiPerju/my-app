/**
 * The capability-root scanner and manifest reader (`scripts/shared/manifests.ts`) plus the
 * descriptor builder (`scripts/registry/build-registry.ts`).
 *
 * Every first-party root lives at exactly `capabilities/<kind>/<id>`: discovery enforces the
 * depth-two `<kind>/<id>` topology in one pass (there is no second validation walk), duplicate
 * leaf ids across different kinds are allowed, and the builder emits descriptor v3 only —
 * fully qualified `registry/kind/id` references, no per-capability `path`, sorted by full
 * identity. These tests drive the scanner and the builder against synthetic tmp repos, and
 * re-assert the real repo.
 */

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildDescriptor } from "../../scripts/registry/build-registry";
import { readCapabilityRoots, readManifests } from "../../scripts/shared/manifests";
import { withRepo, writeCap } from "./support/registry-fixture";
import {
  CAPABILITIES_DIR,
  capabilityDir,
  capabilityLocalIds,
  readJson,
  REGISTRY_ROOT,
} from "./support/template-tree";

interface KindDef {
  id: string;
  title: string;
  weight: number;
  min: number;
  max?: number;
}

/** Write a repo-root `registry.config.json` with the given kinds. */
const writeConfig = (root: string, kinds: KindDef[], capabilitiesDir?: string): void => {
  writeFileSync(
    join(root, "registry.config.json"),
    JSON.stringify(
      { id: "reg", sources: { ts: "https://example.test/ts/" }, capabilitiesDir, kinds },
      null,
      2,
    ),
  );
};

/** One capability row as these tests read it back from the built descriptor. */
interface DescriptorCapability {
  id: string;
  version: string;
  kind: string;
  dependencies?: string[];
  compatibility?: Record<string, string[]>;
  packages?: string[];
}

/** The descriptor shape these tests assert against. */
interface Descriptor {
  id: string;
  descriptorVersion: number;
  capabilitiesDir?: string;
  kinds: KindDef[];
  capabilities: DescriptorCapability[];
}

describe("kind-qualified capability discovery", () => {
  test("reports each depth-two root's kind, id, and path, sorted by path", () => {
    withRepo(
      (root) => {
        writeCap(root, "frontend/web", { id: "web", version: "1.0.0", kind: "frontend" });
        writeCap(root, "feature/chat", { id: "chat", version: "1.0.0", kind: "feature" });
      },
      (root) => {
        expect(readCapabilityRoots(root)).toEqual([
          { kind: "feature", id: "chat", path: "feature/chat" },
          { kind: "frontend", id: "web", path: "frontend/web" },
        ]);
      },
    );
  });

  test("allows the same leaf id under two different kinds", () => {
    withRepo(
      (root) => {
        writeCap(root, "frontend/search", { id: "search", version: "1.0.0", kind: "frontend" });
        writeCap(root, "feature/search", { id: "search", version: "1.0.0", kind: "feature" });
      },
      (root) => {
        expect(readCapabilityRoots(root)).toEqual([
          { kind: "feature", id: "search", path: "feature/search" },
          { kind: "frontend", id: "search", path: "frontend/search" },
        ]);
      },
    );
  });

  test("prunes node_modules/.git/.venv and does not descend into a root", () => {
    withRepo(
      (root) => {
        writeCap(root, "base/core", { id: "core", version: "1.0.0", kind: "base" });
        writeCap(root, "node_modules/pkg", { id: "pkg", version: "1.0.0", kind: "x" });
        writeCap(root, ".git/x", { id: "x", version: "1.0.0", kind: "x" });
        writeCap(root, ".venv/z", { id: "z", version: "1.0.0", kind: "x" });
        // A directory nested INSIDE a root is not a second root: the walk stops at `base/core`.
        writeCap(root, "base/core/inner", { id: "inner", version: "1.0.0", kind: "x" });
      },
      (root) => {
        expect(readCapabilityRoots(root)).toEqual([
          { kind: "base", id: "core", path: "base/core" },
        ]);
      },
    );
  });

  test(".mistral is NOT pruned, so a root hidden under it is surfaced rather than ignored", () => {
    withRepo(
      // Only `.git`/`node_modules`/`.venv` are pruned (matching the CLI); a capability.json under a
      // `.mistral` dir is discovered and, being mis-located, rejected — never silently hidden.
      (root) =>
        writeCap(root, ".mistral/base/core", { id: "core", version: "1.0.0", kind: "base" }),
      (root) => {
        expect(() => readCapabilityRoots(root)).toThrow(/must live at exactly `<kind>\/<id>`/);
        expect(() => readCapabilityRoots(root)).toThrow(/\.mistral\/base\/core/);
      },
    );
  });

  test("a capability.json at the capabilities dir itself (depth zero) is rejected, not ignored", () => {
    withRepo(
      (root) => {
        const dir = join(root, "capabilities");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "capability.json"),
          JSON.stringify({ id: "x", version: "1.0.0", kind: "feature" }, null, 2),
        );
      },
      (root) => {
        expect(() => readCapabilityRoots(root)).toThrow(/must live at exactly `<kind>\/<id>`/);
      },
    );
  });

  test("a shallow root (depth one) is a topology error", () => {
    withRepo(
      (root) => writeCap(root, "core", { id: "core", version: "1.0.0", kind: "base" }),
      (root) => {
        expect(() => readCapabilityRoots(root)).toThrow(/must live at exactly `<kind>\/<id>`/);
        expect(() => readCapabilityRoots(root)).toThrow(/capabilities\/core/);
      },
    );
  });

  test("an over-nested root (depth three) is a topology error", () => {
    withRepo(
      (root) =>
        writeCap(root, "feature/group/chat", { id: "chat", version: "1.0.0", kind: "feature" }),
      (root) => {
        expect(() => readCapabilityRoots(root)).toThrow(/must live at exactly `<kind>\/<id>`/);
        expect(() => readCapabilityRoots(root)).toThrow(/feature\/group\/chat/);
      },
    );
  });

  test("with a `.` prefix, the shared packages/* tier is excluded from discovery", () => {
    const root = mkdtempSync(join(tmpdir(), "cap-flat-"));
    try {
      // A `.` prefix puts capability roots at `<kind>/<id>` off the repo root; `packages/*` is a
      // sibling shared tier, not a capability grouping dir, and must stay out of discovery.
      const chat = join(root, "feature", "chat");
      mkdirSync(chat, { recursive: true });
      writeFileSync(
        join(chat, "capability.json"),
        JSON.stringify({ id: "chat", version: "1.0.0", kind: "feature" }, null, 2),
      );
      const shared = join(root, "packages", "shared");
      mkdirSync(shared, { recursive: true });
      writeFileSync(
        join(shared, "capability.json"),
        JSON.stringify({ id: "shared", version: "1.0.0", kind: "packages" }, null, 2),
      );
      expect(readCapabilityRoots(root, ".").map((r) => r.path)).toEqual(["feature/chat"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("readManifests attaches the discovered `<kind>/<id>` path to every manifest", () => {
    withRepo(
      (root) => writeCap(root, "feature/chat", { id: "chat", version: "1.0.0", kind: "feature" }),
      (root) => {
        const chat = readManifests(root)[0]!;
        expect(chat.path).toBe("feature/chat");
        expect(chat.kind).toBe("feature");
        expect(chat.id).toBe("chat");
      },
    );
  });

  test("a manifest whose id disagrees with its directory is rejected", () => {
    withRepo(
      (root) => writeCap(root, "feature/wrong", { id: "chat", version: "1.0.0", kind: "feature" }),
      (root) => {
        expect(() => readManifests(root)).toThrow(/capabilities\/feature\/wrong/);
        expect(() => readManifests(root)).toThrow(/must equal the root directory's last segment/);
      },
    );
  });

  test("a manifest whose kind disagrees with its parent directory is rejected", () => {
    withRepo(
      (root) => writeCap(root, "feature/chat", { id: "chat", version: "1.0.0", kind: "frontend" }),
      (root) => {
        expect(() => readManifests(root)).toThrow(/capabilities\/feature\/chat/);
        expect(() => readManifests(root)).toThrow(
          /must equal the root's parent directory `feature`/,
        );
      },
    );
  });

  test("an authored `path` key in capability.json is rejected — path is discovered", () => {
    withRepo(
      (root) =>
        writeCap(root, "feature/chat", {
          id: "chat",
          version: "1.0.0",
          kind: "feature",
          path: "elsewhere/chat",
        }),
      (root) => {
        expect(() => readManifests(root)).toThrow(/authors a `path` key/);
        expect(() => readManifests(root)).toThrow(/capabilities\/feature\/chat/);
      },
    );
  });
});

describe("descriptor v3 emission", () => {
  test("stamps descriptorVersion 3, emits no per-capability path, and uses the canonical envelope order", () => {
    withRepo(
      (root) => {
        writeConfig(root, [{ id: "feature", title: "Features", weight: 0, min: 0 }]);
        writeCap(root, "feature/chat", { id: "chat", version: "1.0.0", kind: "feature" });
      },
      (root) => {
        // SAFETY: buildDescriptor serialized this exact descriptor above; parsed only to read shape.
        const descriptor = JSON.parse(buildDescriptor(root)) as Descriptor;
        expect(descriptor.descriptorVersion).toBe(3);
        expect(Object.keys(descriptor)).toEqual([
          "id",
          "descriptorVersion",
          "sources",
          "kinds",
          "capabilities",
        ]);
        expect(descriptor.capabilities.every((c) => !("path" in c))).toBe(true);
      },
    );
  });

  test("qualifies every dependency to a full registry/kind/id reference, sorted and unique", () => {
    withRepo(
      (root) => {
        writeConfig(root, [
          { id: "base", title: "Base", weight: 0, min: 1, max: 1 },
          { id: "feature", title: "Features", weight: 10, min: 0 },
        ]);
        writeCap(root, "base/core", { id: "core", version: "1.0.0", kind: "base", required: true });
        writeCap(root, "feature/chat", {
          id: "chat",
          version: "1.0.0",
          kind: "feature",
          // A bare unique leaf and an explicit local `kind/id` both qualify to the full identity.
          dependencies: ["core", "base/core"],
        });
      },
      (root) => {
        // SAFETY: buildDescriptor serialized this exact descriptor above; parsed only to read shape.
        const descriptor = JSON.parse(buildDescriptor(root)) as Descriptor;
        const chat = descriptor.capabilities.find((c) => c.id === "chat")!;
        expect(chat.dependencies).toEqual(["reg/base/core"]);
      },
    );
  });

  test("orders capabilities by full identity and keeps two leaf-equal capabilities distinct", () => {
    withRepo(
      (root) => {
        writeConfig(root, [
          { id: "feature", title: "Features", weight: 10, min: 0 },
          { id: "frontend", title: "Frontend", weight: 0, min: 0 },
        ]);
        writeCap(root, "frontend/search", { id: "search", version: "1.0.0", kind: "frontend" });
        writeCap(root, "feature/search", { id: "search", version: "1.0.0", kind: "feature" });
      },
      (root) => {
        // SAFETY: buildDescriptor serialized this exact descriptor above; parsed only to read shape.
        const descriptor = JSON.parse(buildDescriptor(root)) as Descriptor;
        expect(descriptor.capabilities.map((c) => `${c.kind}/${c.id}`)).toEqual([
          "feature/search",
          "frontend/search",
        ]);
      },
    );
  });

  test("records a configured capabilitiesDir", () => {
    withRepo(
      (root) => {
        writeConfig(root, [{ id: "feature", title: "Features", weight: 0, min: 0 }], "caps");
        const dir = join(root, "caps", "feature", "chat");
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          join(dir, "capability.json"),
          JSON.stringify({ id: "chat", version: "1.0.0", kind: "feature" }, null, 2),
        );
      },
      (root) => {
        // SAFETY: buildDescriptor serialized this exact descriptor above; parsed only to read shape.
        const descriptor = JSON.parse(buildDescriptor(root)) as Descriptor;
        expect(descriptor.capabilitiesDir).toBe("caps");
        expect(descriptor.capabilities.map((c) => c.id)).toEqual(["chat"]);
      },
    );
  });

  test("a config declaring no kinds is rejected", () => {
    withRepo(
      (root) => {
        writeFileSync(
          join(root, "registry.config.json"),
          JSON.stringify({ id: "reg", sources: { ts: "https://example.test/ts/" } }, null, 2),
        );
        writeCap(root, "feature/chat", { id: "chat", version: "1.0.0", kind: "feature" });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(/declares no `kinds`/);
      },
    );
  });

  test("a capability declaring an undeclared kind is rejected", () => {
    withRepo(
      (root) => {
        writeConfig(root, [{ id: "feature", title: "Features", weight: 0, min: 0 }]);
        writeCap(root, "backend/fastapi", { id: "fastapi", version: "1.0.0", kind: "backend" });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(/not declared in registry.config.json/);
      },
    );
  });

  test("a bare dependency that is ambiguous across kinds is rejected", () => {
    withRepo(
      (root) => {
        writeConfig(root, [
          { id: "feature", title: "Features", weight: 0, min: 0 },
          { id: "frontend", title: "Frontend", weight: 10, min: 0 },
        ]);
        writeCap(root, "frontend/search", { id: "search", version: "1.0.0", kind: "frontend" });
        writeCap(root, "feature/search", { id: "search", version: "1.0.0", kind: "feature" });
        writeCap(root, "feature/chat", {
          id: "chat",
          version: "1.0.0",
          kind: "feature",
          dependencies: ["search"],
        });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(/ambiguous capability reference `search`/);
      },
    );
  });

  test("two capabilities that render the same npm name collide", () => {
    withRepo(
      (root) => {
        writeConfig(root, [
          { id: "a-b", title: "A-B", weight: 0, min: 0 },
          { id: "a", title: "A", weight: 10, min: 0 },
        ]);
        writeCap(root, "a-b/c", { id: "c", version: "1.0.0", kind: "a-b", packages: ["ts"] });
        writeCap(root, "a/b-c", { id: "b-c", version: "1.0.0", kind: "a", packages: ["ts"] });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(/ts package name `@reg\/a-b-c`/);
      },
    );
  });

  test("two capabilities that render the same normalized python name collide", () => {
    withRepo(
      (root) => {
        writeConfig(root, [{ id: "feature", title: "Features", weight: 0, min: 0 }]);
        writeCap(root, "feature/chat_x", {
          id: "chat_x",
          version: "1.0.0",
          kind: "feature",
          packages: ["py"],
        });
        writeCap(root, "feature/chat-x", {
          id: "chat-x",
          version: "1.0.0",
          kind: "feature",
          packages: ["py"],
        });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(/py package name `reg-feature-chat-x`/);
      },
    );
  });

  test("a compatibility target whose resolved kind differs from its map key is rejected", () => {
    withRepo(
      (root) => {
        writeConfig(root, [
          { id: "base", title: "Base", weight: 0, min: 0 },
          { id: "feature", title: "Features", weight: 10, min: 0 },
        ]);
        writeCap(root, "base/core", { id: "core", version: "1.0.0", kind: "base" });
        writeCap(root, "feature/chat", {
          id: "chat",
          version: "1.0.0",
          kind: "feature",
          // Listed under kind `base`, but the target resolves to a `feature` capability.
          compatibility: { base: ["feature/chat"] },
        });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(
          /compatibility lists `reg\/feature\/chat` under kind `base`, but that reference's kind is `feature`/,
        );
      },
    );
  });

  test("a compatibility map keyed by an undeclared kind is rejected", () => {
    withRepo(
      (root) => {
        writeConfig(root, [
          { id: "base", title: "Base", weight: 0, min: 0 },
          { id: "feature", title: "Features", weight: 10, min: 0 },
        ]);
        writeCap(root, "base/core", { id: "core", version: "1.0.0", kind: "base" });
        writeCap(root, "feature/chat", {
          id: "chat",
          version: "1.0.0",
          kind: "feature",
          // The key agrees with the foreign target's kind segment, so the per-target kind check
          // passes — but `unknown` is not a declared kind, which the emitter must still reject.
          compatibility: { unknown: ["otherreg/unknown/x"] },
        });
      },
      (root) => {
        expect(() => buildDescriptor(root)).toThrow(
          /compatibility declares kind `unknown`, which is not declared in registry.config.json/,
        );
      },
    );
  });

  test("a capabilitiesDir that escapes the repo root or is absolute is rejected before scanning", () => {
    withRepo(
      (root) => {
        writeCap(root, "feature/chat", { id: "chat", version: "1.0.0", kind: "feature" });
        // A contained custom prefix holding a valid depth-two root.
        const caps = join(root, "caps", "feature", "chat");
        mkdirSync(caps, { recursive: true });
        writeFileSync(
          join(caps, "capability.json"),
          JSON.stringify({ id: "chat", version: "1.0.0", kind: "feature" }, null, 2),
        );
      },
      (root) => {
        expect(() => readManifests(root, "../outside")).toThrow(/escapes the repository root/);
        expect(() => readManifests(root, "/etc")).toThrow(/must be a repo-relative path/);
        // The default and a contained custom prefix both pass the containment guard.
        expect(() => readManifests(root)).not.toThrow();
        expect(readManifests(root, "caps").map((m) => m.path)).toEqual(["feature/chat"]);
      },
    );
  });

  test("the real repo is nested by kind and published under descriptor v3 with no path", () => {
    for (const manifest of readManifests(REGISTRY_ROOT)) {
      expect(manifest.path, `${manifest.id} must carry its nested path`).toBe(
        `${manifest.kind}/${manifest.id}`,
      );
    }
    const committed = readJson<Descriptor>(join(REGISTRY_ROOT, "registry.json"));
    expect(committed.descriptorVersion).toBe(3);
    expect(committed.capabilitiesDir).toBeUndefined();
    expect(committed.capabilities.every((c) => !("path" in c))).toBe(true);
  });
});

describe("capabilityDir resolution", () => {
  test("resolves a known local id to its discovered root directory", () => {
    for (const localId of capabilityLocalIds) {
      expect(capabilityDir(localId).startsWith(CAPABILITIES_DIR)).toBe(true);
      expect(capabilityDir(localId).endsWith(`/${localId}`)).toBe(true);
    }
  });

  test("throws on an unknown id rather than fabricating a top-level path", () => {
    expect(() => capabilityDir("does-not-exist")).toThrow(/unknown capability id `does-not-exist`/);
  });
});
