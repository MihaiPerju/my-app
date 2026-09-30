/**
 * The Docker Compose concern is owned by the docker-compose capability and its hidden integration
 * capabilities, and by nothing else.
 *
 * This proves the ticket's acceptance shapes that are decidable from the registry alone:
 *  - deployment-free generation (a `core + fastapi` closure) contains no Compose, gateway, or smoke
 *    asset and no compose nx project;
 *  - a Compose selection contributes every root, the gated overlays, the gateway, the smoke
 *    runbook, and the nx project, each with a single owner;
 *  - each service/auth overlay belongs to its `docker-compose-<x>` integration, while generic
 *    Compose roots, init aggregation, smoke tooling, and tasks stay with docker-compose;
 *  - the manifest is a template-only, opt-in, `core`-dependent deployment capability.
 *
 * The full generated-file removal contract (pristine removal, modified-orphan retention, owner
 * return on byte identity, transactional replacement, byte stability, divergent-owner failure)
 * needs the Apps CLI's generic owner-aware orphan cleanup for Handlebars output, a pending
 * Dashboard contract. Those checks are committed against the target behavior but cannot execute
 * here; see the blocked block at the end.
 */

import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";

import { readFileSync } from "node:fs";

import { capabilities, capabilityLocalIds, closure, toLocalId } from "../support/selection";
import { capabilityDir, contributedPaths } from "../support/template-tree";

const OWNER_LOCAL = toLocalId("docker-compose");

const OWNER = "docker-compose";

// Each hidden integration owns exactly its per-service overlays; every other Compose asset stays
// with docker-compose. Overlay names are rendered (`.hbs` stripped), matching `contributedPaths`.
const INTEGRATION_OVERLAYS = {
  "docker-compose-api": [
    ".agents/skills/capability-docker-compose-api/SKILL.md",
    "deploy/compose/compose.api.yaml",
    "deploy/compose/compose.api.dev.yaml",
  ],
  "docker-compose-web": [
    ".agents/skills/capability-docker-compose-web/SKILL.md",
    "deploy/compose/compose.web.yaml",
    "deploy/compose/compose.web.dev.yaml",
  ],
  "docker-compose-workflows": [
    ".agents/skills/capability-docker-compose-workflows/SKILL.md",
    "deploy/compose/compose.workflows.yaml",
    "deploy/compose/compose.workflows.dev.yaml",
    "deploy/compose/workflows.defaults.env",
  ],
  "docker-compose-postgres": [
    ".agents/skills/capability-docker-compose-postgres/SKILL.md",
    "deploy/compose/compose.postgres.yaml",
  ],
  "docker-compose-bucket": [
    ".agents/skills/capability-docker-compose-bucket/SKILL.md",
    "deploy/compose/compose.bucket.yaml",
  ],
  "docker-compose-auth": [
    ".agents/skills/capability-docker-compose-auth/SKILL.md",
    "deploy/compose/compose.api.auth.dev.yaml",
    "deploy/compose/compose.gateway.yaml",
    "deploy/compose/compose.web.auth.dev.yaml",
    "deploy/compose/compose.web.auth.yaml",
    "deploy/docker/Dockerfile.gateway",
    "deploy/docker/gateway/apisix.yaml",
    "deploy/docker/gateway/config.yaml",
    "deploy/docker/keycloak/realm.json",
  ],
};

const contributionsFor = (selection: string[]): Map<string, string[]> => {
  const owners = new Map<string, string[]>();
  for (const id of closure(selection)) {
    for (const path of contributedPaths(id)) {
      const ownersForPath = owners.get(path);
      if (ownersForPath === undefined) owners.set(path, [id]);
      else ownersForPath.push(id);
    }
  }
  return owners;
};

// A path is a Compose/gateway/smoke asset if it lives under the Compose tree, the gateway/keycloak
// docker config, the gateway image, the smoke runbook, or the compose nx project and shell tool.
const isComposeAsset = (path: string): boolean =>
  path.startsWith("deploy/compose/") ||
  path.startsWith("deploy/docker/gateway/") ||
  path.startsWith("deploy/docker/keycloak/") ||
  path === "deploy/docker/Dockerfile.gateway" ||
  path === "deploy/docker/Dockerfile.init" ||
  path === "tools/smoke.sh" ||
  path === "tools/compose.sh" ||
  path === "tasks/compose/project.json";

describe("docker-compose manifest", () => {
  const manifest = capabilities.get(OWNER_LOCAL);

  test("is a template-only, opt-in deployment capability that depends only on core", () => {
    expect(manifest, "docker-compose capability is missing").toBeDefined();
    expect(manifest?.kind).toBe("deployment");
    // `apps` is the default deployment, so Compose is only ever selected on purpose.
    expect(manifest?.default).not.toBe(true);
    expect(manifest?.required).not.toBe(true);
    // Compose no longer forces the API runtime. Every per-service overlay — including the one that
    // runs the API image — is owned by a hidden docker-compose-<x> integration, so the generic
    // capability depends only on core. See the integration capabilities and compose.yaml includes.
    expect(manifest?.dependencies).toEqual(["core"]);
    // Template-only: no package language, so it publishes no marker package and rides sources.git.
    expect(manifest?.packages ?? []).toEqual([]);
    expect(
      existsSync(join(capabilityDir(OWNER), "package")),
      "template-only cap ships no package/",
    ).toBe(false);
  });
});

describe("deployment-free generation", () => {
  // `mistral apps init --caps fastapi`: the required core plus fastapi's closure, with docker-compose (a
  // default, not a dependency) deliberately absent.
  const closureIds = closure(["fastapi"]);

  test("does not pull in docker-compose", () => {
    expect([...closureIds].includes(OWNER_LOCAL)).toBe(false);
  });

  test("contributes no Compose, gateway, or smoke asset", () => {
    const strays = [...contributionsFor(["fastapi"]).keys()].filter(isComposeAsset).toSorted();
    expect(strays, "a deployment-free app must contain no Compose/gateway/smoke output").toEqual(
      [],
    );
  });

  test("exposes no compose nx project", () => {
    expect(contributionsFor(["fastapi"]).has("tasks/compose/project.json")).toBe(false);
  });
});

describe("compose-selected generation", () => {
  // Everything that can produce a Compose service, plus the owner.
  const selected = [
    "docker-compose",
    "auth",
    "fastapi",
    "tanstack-start",
    "workflows",
    "postgres",
    "bucket",
  ];
  const contributions = contributionsFor(selected);

  test("contributes all four Compose roots", () => {
    for (const root of [
      "compose.yaml",
      "compose.dev.yaml",
      "compose.gateway.yaml",
      "compose.init.yaml",
    ]) {
      expect(contributions.has(`deploy/compose/${root}`), `${root} missing`).toBe(true);
    }
  });

  test("contributes every per-service overlay for the selected services", () => {
    for (const overlay of [
      "compose.api.yaml",
      "compose.api.dev.yaml",
      "compose.web.yaml",
      "compose.web.dev.yaml",
      "compose.workflows.yaml",
      "compose.workflows.dev.yaml",
      "compose.postgres.yaml",
      "compose.bucket.yaml",
      "workflows.defaults.env",
    ]) {
      expect(contributions.has(`deploy/compose/${overlay}`), `${overlay} missing`).toBe(true);
    }
  });

  test("contributes the gateway, init image, smoke runbook, and task module", () => {
    for (const path of [
      "deploy/docker/gateway/apisix.yaml",
      "deploy/docker/gateway/config.yaml",
      "deploy/docker/keycloak/realm.json",
      "deploy/docker/Dockerfile.gateway",
      "deploy/docker/Dockerfile.init",
      "tools/smoke.sh",
      "tasks/compose/project.json",
      "tools/compose.sh",
    ]) {
      expect(contributions.has(path), `${path} missing`).toBe(true);
    }
  });

  test("every Compose asset has a single owner — no path is co-owned", () => {
    const coOwned = [...contributions]
      .filter(([path, owners]) => isComposeAsset(path) && owners.length > 1)
      .map(([path, owners]) => `${path}: ${owners.join(", ")}`);
    expect(coOwned, "every Compose asset must have exactly one owner").toEqual([]);
  });

  test("each integration owns exactly its overlays; docker-compose owns the shared assets", () => {
    for (const [id, files] of Object.entries(INTEGRATION_OVERLAYS)) {
      expect(contributedPaths(toLocalId(id)).toSorted(), `${id} owns exactly its overlays`).toEqual(
        files.toSorted(),
      );
    }
    const integrationFiles = new Set(Object.values(INTEGRATION_OVERLAYS).flat());
    const misowned = [...contributions]
      .filter(([path]) => isComposeAsset(path) && !integrationFiles.has(path))
      .filter(([, owners]) => owners.length !== 1 || owners[0] !== OWNER_LOCAL)
      .map(([path, owners]) => `${path}: ${owners.join(", ")}`);
    expect(misowned, "every shared Compose asset must be owned solely by docker-compose").toEqual(
      [],
    );
  });

  test("web and API defaults support direct and gateway topologies", () => {
    const webDev = readFileSync(
      join(capabilityDir("docker-compose-web"), "template/deploy/compose/compose.web.dev.yaml.hbs"),
      "utf8",
    );
    const webProduction = readFileSync(
      join(capabilityDir("docker-compose-web"), "template/deploy/compose/compose.web.yaml.hbs"),
      "utf8",
    );
    const api = readFileSync(
      join(capabilityDir("docker-compose-api"), "template/deploy/compose/compose.api.dev.yaml.hbs"),
      "utf8",
    );
    const authWebDev = readFileSync(
      join(
        capabilityDir("docker-compose-auth"),
        "template/deploy/compose/compose.web.auth.dev.yaml",
      ),
      "utf8",
    );
    const authWebProduction = readFileSync(
      join(capabilityDir("docker-compose-auth"), "template/deploy/compose/compose.web.auth.yaml"),
      "utf8",
    );
    const authApi = readFileSync(
      join(
        capabilityDir("docker-compose-auth"),
        "template/deploy/compose/compose.api.auth.dev.yaml",
      ),
      "utf8",
    );
    const dockerfile = readFileSync(
      join(capabilityDir("tanstack-start"), "template/deploy/docker/Dockerfile.web"),
      "utf8",
    );

    for (const web of [webDev, webProduction]) {
      expect(web).toContain("VITE_API_URL: ${VITE_API_URL-http://localhost:${API_PORT:-3000}}");
    }
    for (const web of [authWebDev, authWebProduction]) {
      expect(web).toContain('VITE_API_URL: ""');
    }
    expect(api).toContain("CORS_ORIGIN: http://localhost:${WEB_PORT:-3001}");
    expect(authApi).toContain("CORS_ORIGIN: http://localhost:${GATEWAY_PORT:-9080}");
    expect(dockerfile).toContain("ARG VITE_API_URL=http://localhost:3000");
  });
});

describe("only the Docker Compose capabilities contribute Compose assets", () => {
  test("across the catalog, only docker-compose and its integrations ship Compose output", () => {
    const composeCaps = new Set([OWNER_LOCAL, ...Object.keys(INTEGRATION_OVERLAYS).map(toLocalId)]);
    const trespassers: string[] = [];
    for (const id of capabilityLocalIds) {
      if (composeCaps.has(id)) continue;
      const offending = contributedPaths(id).filter(isComposeAsset);
      if (offending.length > 0) trespassers.push(`${id}: ${offending.join(", ")}`);
    }
    expect(trespassers, "only docker-compose and its integrations may ship Compose output").toEqual(
      [],
    );
  });
});

// ---------------------------------------------------------------------------------------------
// BLOCKED — the generated-file removal / reconciliation contract.
//
// These are committed against the agreed target behavior (spec: "generic generated-file
// reconciliation gains owner-aware orphan cleanup") but cannot execute against the registry alone:
// they require the Apps CLI's generic owner-aware orphan cleanup for Handlebars output, which is a
// pending Dashboard deliverable (dashboard/.scratch/capability-kind-selection/
// remove-compose-generator-feature-request.md). Un-skip once a CLI carrying that contract is
// available; they are never reported as passing by inference.
// ---------------------------------------------------------------------------------------------
describe("generated-file removal contract (blocked on the generic orphan-HBS cleanup CLI)", () => {
  const BLOCKED = "blocked: needs the Apps CLI generic owner-aware orphan-HBS cleanup contract";

  test.skip(`removing docker-compose deletes its pristine generated Compose files [${BLOCKED}]`, () => {});
  test.skip(`a modified Compose file is preserved byte-for-byte and reported unmanaged [${BLOCKED}]`, () => {});
  test.skip(`a returning docker-compose adopts an orphan only when byte-identical [${BLOCKED}]`, () => {});
  test.skip(`transactional selection replacement restores prior state on failure [${BLOCKED}]`, () => {});
  test.skip(`repeated wiring of the same selection is byte-stable [${BLOCKED}]`, () => {});
  test.skip(`divergent owners of a shared Compose destination fail with provenance [${BLOCKED}]`, () => {});
});
