/** Python distribution names, namespaces, and cross-capability dependency edges. */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, relative } from "node:path";

import { capabilities, closure } from "../support/selection";
import {
  PY_NAMESPACE,
  REGISTRY_ID,
  pyCapabilities,
  siblingImports,
} from "../support/registry-fixtures";
import {
  capabilityLocalIds,
  normalizePyDistName,
  pyDistNameFor,
  REGISTRY_ROOT,
  requirementName,
  walk,
} from "../support/template-tree";

/** The PEP 503-normalized extras of a PEP 508 requirement: `pkg[a,b_c]>=1` -> `a`, `b-c`. */
const extrasOf = (requirement: string): string[] =>
  (/^[^[]*\[([^\]]*)\]/.exec(requirement)?.[1] ?? "")
    .split(",")
    .map((extra) => normalizePyDistName(extra.trim()))
    .filter(Boolean);

describe("Python capability packages", () => {
  // The CLI writes the backend dependency as `<registry id>-<capability id>`, but the published
  // dist name comes from this file. A mismatch surfaces as a 404 in a user's `uv lock`. A bare
  // name is also unscoped: `search` and `speech` are live projects on public PyPI, so a backend
  // with no private index resolves a stranger's package.
  test("every py capability's dist name follows `<registry id>-<capability id>`", () => {
    for (const { id, pyproject } of pyCapabilities()) {
      const declared = pyproject.project?.name;
      expect(declared, `${id}: no [project].name in package/py/pyproject.toml`).toBeDefined();
      const expected = pyDistNameFor(REGISTRY_ID, id);
      expect(declared, `${id}: dist name "${declared}" != convention "${expected}"`).toBe(expected);
    }
  });

  // The import path is decoupled from the dist name by `module-name`, so nothing forces the two
  // to agree on whose registry this is -- and for a long time they did not: the dists were
  // `mistralai-capabilities-*` while every import read `solutions_capabilities.*`, a leftover from
  // the repo this one replaced. Only the ROOT is pinned: the second segment is the capability's
  // own choice (`evals` ships `feedback`, `guardrailing` ships `guardrails`).
  test("every py capability imports under the registry's own namespace", () => {
    for (const { id, moduleName } of pyCapabilities()) {
      expect(moduleName, `${id}: no [tool.uv.build-backend].module-name`).toBeDefined();
      expect(
        moduleName,
        `${id}: module-name "${moduleName}" is not under "${PY_NAMESPACE}."`,
      ).toMatch(new RegExp(`^${PY_NAMESPACE}\\.`));
    }
  });

  // One symmetric rule governs every cross-capability Python edge, because the two ways to get it
  // wrong fail in opposite directions and BOTH are invisible to this repo's own workspace (which
  // installs every member, so any sibling import resolves here regardless).
  //
  // Declaring a sibling as a Python dependency breaks the generated app: the CLI wires every
  // SELECTED toolkit into the app root as a path source, so a second edge from inside a toolkit
  // reaches the same distribution twice and `uv lock` dies on "conflicting URLs ... (editable)".
  //
  // NOT declaring the capability edge breaks the generated app the other way: the CLI installs
  // only the selected closure, so an app that takes the importer without its sibling fails at
  // import time.
  //
  // Together: the edge belongs in capability.json `dependencies` and nowhere else. See the
  // write-ups beside `chat` -> `api` and `document-annotation-ui` -> `bucket`.
  test("every cross-capability py import is a capability.json edge and not a Python dependency", () => {
    const py = pyCapabilities();
    // `module-name`'s second segment is the capability's own choice, so map it back explicitly
    // rather than assuming it equals the id (`evals` ships `feedback`).
    const ownerOfModule = new Map(
      py.flatMap(({ id, moduleName }) => {
        const segment = moduleName?.split(".")[1];
        return segment === undefined ? [] : [[segment, id] as const];
      }),
    );
    const idOfDist = new Map(capabilityLocalIds.map((id) => [pyDistNameFor(REGISTRY_ID, id), id]));
    for (const { id, dir, pyproject } of py) {
      const declared = [
        ...(pyproject.project?.dependencies ?? []),
        ...Object.values(pyproject.project?.["optional-dependencies"] ?? {}).flat(),
      ];
      const requirements = declared.map(requirementName);
      // A declared requirement always carries a project name; a blank parse means requirementName
      // failed to recognize the spec, which would then also skip the sibling check below silently.
      for (const [i, name] of requirements.entries()) {
        expect(name, `${id}/package/py: unparseable requirement "${declared[i]}"`).not.toBe("");
      }
      const bound = Object.keys(pyproject.tool?.uv?.sources ?? {}).map(normalizePyDistName);

      for (const name of [...requirements, ...bound]) {
        const sibling = idOfDist.get(name);
        if (sibling === undefined || sibling === id) continue;
        expect(
          false,
          `${id}/package/py declares sibling capability "${sibling}" (${name}) as a Python ` +
            `dependency; declare it in ${id}/capability.json "dependencies" instead`,
        ).toBe(true);
      }

      const effective = closure([id]);
      const src = join(dir, "src");
      for (const file of walk(src).filter((path) => path.endsWith(".py"))) {
        for (const segment of siblingImports(readFileSync(file, "utf8"))) {
          const owner = ownerOfModule.get(segment);
          if (owner === undefined || owner === id) continue;
          expect(
            effective.has(owner),
            `${relative(REGISTRY_ROOT, file)} imports ${PY_NAMESPACE}.${segment} (owned by ` +
              `"${owner}") but selecting ${id} does not make that capability effective`,
          ).toBe(true);
        }
      }
    }
  });

  // The SDK's payload encoder raises ImportError at worker start when encryption is configured and
  // `cryptography` is absent, and only `mistralai[workflow-payload-encryption]` brings it in. This
  // repo's own lock (and any app that selects `search`) gets `cryptography` transitively through
  // azure/authlib, which is how a workflows-only app shipped a worker that could not start. So the
  // capability whose env default turns encryption on must carry the extra in its OWN toolkit.
  test("a capability that defaults payload encryption on declares the SDK's encryption extra", () => {
    const EXTRA = "workflow-payload-encryption";
    const py = new Map(pyCapabilities().map((cap) => [cap.id, cap]));
    const enabling = [...capabilities].filter(([, capability]) => {
      const mode = capability.envVars?.WORKFLOWS_ENCRYPTION_MODE;
      return mode !== undefined && mode !== "off";
    });
    expect(enabling.length, "no capability defaults WORKFLOWS_ENCRYPTION_MODE on").toBeGreaterThan(
      0,
    );
    for (const [id] of enabling) {
      const declared = py.get(id)?.pyproject.project?.dependencies ?? [];
      const carries = declared.some(
        (requirement) =>
          requirementName(requirement) === "mistralai" && extrasOf(requirement).includes(EXTRA),
      );
      expect(
        carries,
        `${id} defaults WORKFLOWS_ENCRYPTION_MODE on, so its package/py must depend on ` +
          `"mistralai[${EXTRA}]"; without it the worker crashes in any app that lacks another ` +
          "path to cryptography",
      ).toBe(true);
    }
  });
});
