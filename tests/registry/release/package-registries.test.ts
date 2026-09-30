import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";

import {
  buildBunfigScopes,
  buildNpmrc,
  patchCorePyproject,
  patchRegistryGitignore,
  patchRegistryUvWrapper,
  readRegistryPinCarriers,
  type RegistryPinCarrier,
  registryPins,
} from "../../../scripts/registry/app-registry-pins";
import {
  DEFAULT_PACKAGE_REGISTRY,
  INTERNAL_PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRIES,
  PACKAGE_REGISTRY_IDS,
  PACKAGE_REGISTRY_LANGUAGES,
  type PackageRegistryId,
} from "../../../scripts/release/package-registries";
import { readManifests, registryPinCarriers } from "../../../scripts/shared/manifests";
import { REGISTRY_ID, pyCapabilities, readCorePyprojectRaw } from "../support/registry-fixtures";
import { withRepo, writeCap } from "../support/registry-fixture";
import {
  capabilityLocalIds,
  normalizePyDistName,
  pyDistNameFor,
  readJson,
  REGISTRY_ROOT,
  templateDir,
  walk,
} from "../support/template-tree";

const UV_INDEX_DECLARATION = /^\s*\[\[tool\.uv\.index\]\]\s*$/;
const UV_SOURCE_TABLE = /^\s*\[tool\.uv\.sources(?:\.[^\]]+)?\]\s*$/;
const TOML_TABLE = /^\s*\[\[?[^\]]+\]?\]\s*$/;
/** An `index` key, as a dotted-table line or inside an inline table (not `foo-index = …`). */
const UV_SOURCE_INDEX_KEY = /(?:^|[{,])\s*index\s*=/g;
const UV_SOURCE_NAMED_INDEX = /(?:^|[{,])\s*index\s*=\s*"([^"]+)"/g;
const UV_SCALAR_INDEX_SETTING = /^\s*(?!#)(?:index-url|extra-index-url|find-links)\s*=/;
const BUN_SCOPES_TABLE = /^\s*\[install\.scopes\]\s*$/;

/** The index names core's app template declares, the only ones a capability binding can resolve. */
function coreIndexNames(): Set<string> {
  // SAFETY: repo-owned pyproject; a shape mismatch yields no names, which flags every binding.
  const parsed = Bun.TOML.parse(readCorePyprojectRaw()) as {
    tool?: { uv?: { index?: { name?: string }[] } };
  };
  return new Set((parsed.tool?.uv?.index ?? []).flatMap(({ name }) => (name ? [name] : [])));
}

/**
 * Whether a template file carries registry connection state that must vary by target index.
 *
 * A source binding names an index; the URL lives in core's declaration, which is what gets
 * projected per index. So a private capability may bind to any index core declares by name: it
 * only ships with an authenticated core, which keeps them all. A public capability may bind only to
 * public PyPI, since the anonymous core projection drops every private index. A templated or
 * undeclared name could resolve anywhere, and fails.
 */
function carriesRegistryConnectionState(
  path: string,
  source: string,
  bindable: ReadonlySet<string>,
): boolean {
  if (/^\.npmrc(?:\.|$)/.test(basename(path))) return true;

  let inUvSources = false;
  for (const line of source.split("\n")) {
    if (UV_INDEX_DECLARATION.test(line) || UV_SCALAR_INDEX_SETTING.test(line)) return true;
    if (BUN_SCOPES_TABLE.test(line)) return true;
    if (TOML_TABLE.test(line)) inUvSources = UV_SOURCE_TABLE.test(line);
    if (!inUvSources || /^\s*#/.test(line)) continue;
    const keys = line.match(UV_SOURCE_INDEX_KEY)?.length ?? 0;
    const names = [...line.matchAll(UV_SOURCE_NAMED_INDEX)].map((match) => match[1]!);
    // Every `index =` on the line must be a double-quoted name this guard parsed; anything else
    // fails closed.
    if (names.length !== keys || names.some((name) => !bindable.has(name))) return true;
  }
  return false;
}

/**
 * Registry-state files outside the per-index projection: any in a capability that did not opt into
 * it, and any in a carrier that its `metadata.registryPins` does not list.
 */
function undeclaredRegistryConnectionState(repoRoot: string): string[] {
  const declared = coreIndexNames();
  return readManifests(repoRoot).flatMap((manifest) => {
    const projected = new Set(manifest.metadata?.registryPins ?? []);
    const template = join(repoRoot, "capabilities", manifest.path, "template");
    const bindable = manifest.metadata?.public === true ? new Set(["pypi"]) : declared;
    return walk(template).flatMap((path) =>
      !projected.has(relative(template, path)) &&
      carriesRegistryConnectionState(path, readFileSync(path, "utf8"), bindable)
        ? [`${manifest.path}/template/${relative(template, path)}`]
        : [],
    );
  });
}

/** The declared carrier at `<kind>/<id>`, failing the test run when it no longer carries pins. */
function pinCarrier(carriers: readonly RegistryPinCarrier[], path: string): RegistryPinCarrier {
  const carrier = carriers.find(({ manifest }) => manifest.path === path);
  if (carrier === undefined) throw new Error(`${path} does not declare metadata.registryPins`);
  return carrier;
}

/** The indexes a carrier is packed for: every one when it is public, the internal ones otherwise. */
function carrierRegistryIds(carrier: RegistryPinCarrier): readonly PackageRegistryId[] {
  return carrier.manifest.metadata?.public === true
    ? PACKAGE_REGISTRY_IDS
    : INTERNAL_PACKAGE_REGISTRY_IDS;
}

/**
 * The descriptor's `sources.{ts,py}` tell a consumer where to install capabilities from. This is a
 * property of the source index, not the release, so one committed value cannot serve two indexes.
 * Each publish step resolves its per-index upload set through `planFor` (see `publish-plan.test.ts`
 * for that routing suite, split out from this file).
 *
 * See `app-registry-pins.test.ts` for the core `package.json` and `bunfig.toml`
 * `minimumReleaseAgeExcludes` projector suites, also split out from this file.
 */
describe("package registries", () => {
  const carriers = readRegistryPinCarriers(REGISTRY_ROOT);
  const coreCarrier = pinCarrier(carriers, "base/core");
  const designSystemCarrier = pinCarrier(carriers, "feature/mistral-design-system");
  const corePins = (id: PackageRegistryId) =>
    registryPins(id, coreCarrier.canonical, coreCarrier.template);
  const canonicalCorePins = {
    gitignore: coreCarrier.canonical.get("gitignore")!,
    pyproject: coreCarrier.canonical.get("pyproject.toml")!,
    uvWrapper: coreCarrier.canonical.get(join("tools", "uv.sh"))!,
  };
  const descriptorSources = readJson<{ sources: Record<string, string> }>(
    join(REGISTRY_ROOT, "registry.json"),
  ).sources;

  // The committed descriptor is what a checkout resolves against, and `mistral apps registry build`
  // carries it forward verbatim. A URL typed here that no index actually serves fails only at a
  // consumer's `bun add`, so it must be one of the indexes the pipeline really publishes to.
  test("the committed descriptor points at the default package registry", () => {
    for (const lang of PACKAGE_REGISTRY_LANGUAGES) {
      expect(descriptorSources[lang]).toBe(PACKAGE_REGISTRIES[DEFAULT_PACKAGE_REGISTRY][lang]);
    }
  });

  test("only a registry-pin carrier's projected files carry registry connection state", () => {
    expect(
      undeclaredRegistryConnectionState(REGISTRY_ROOT),
      "registry connection state must live in a file its capability lists in metadata.registryPins, so pack-all projects it per index",
    ).toEqual([]);
  });

  test("the registry-state guard rejects every supported connection-state shape", () => {
    withRepo(
      (root) => {
        const fixtures = [
          ["npmrc", ".npmrc.local", "@scope:registry=https://registry.example/\n"],
          [
            "uv-index",
            "pyproject.toml",
            '[[tool.uv.index]]\nname = "private"\nurl = "https://registry.example/simple"\n',
          ],
          [
            "uv-source-public-private-index",
            "pyproject.toml.hbs",
            '[tool.uv.sources]\nprivate-package = { index = "mistralai" }\n',
            true,
          ],
          [
            "uv-source-public-second-binding",
            "pyproject.toml",
            '[tool.uv.sources]\npkg = [{ index = "pypi", marker = "a" }, { index = "mistralai", marker = "b" }]\n',
            true,
          ],
          [
            "uv-source-undeclared",
            "pyproject.toml",
            '[tool.uv.sources]\nprivate-package = { index = "gemfury" }\n',
          ],
          [
            "uv-source-templated",
            "pyproject.toml.hbs",
            '[tool.uv.sources]\nprivate-package = { index = "{{registryIndex}}" }\n',
          ],
          [
            "uv-source-unparsed",
            "pyproject.toml",
            "[tool.uv.sources]\nprivate-package = { index = 'mistralai' }\n",
          ],
          // Name-only bindings to an index core declares: any from a private capability, public
          // PyPI from anyone, including as a dotted table.
          [
            "uv-source-private",
            "pyproject.toml",
            '[tool.uv.sources]\nprivate-package = { index = "mistralai" }\nsearch-index = { workspace = true }\n',
          ],
          [
            "uv-source-private-dotted",
            "pyproject.toml",
            '[tool.uv.sources.private-package]\nindex = "mistralai"\n',
          ],
          [
            "uv-source-pypi",
            "pyproject.toml",
            '[tool.uv.sources]\npublic-package = { index = "pypi" }\n',
            true,
          ],
          [
            "uv-scalar",
            "uv.toml",
            'index-url = "https://registry.example/simple"\nextra-index-url = "https://extra.example/simple"\nfind-links = ["https://links.example"]\n',
          ],
        ] as const;
        for (const [id, filename, content, isPublic = false] of fixtures) {
          writeCap(root, `feature/${id}`, {
            id,
            kind: "feature",
            version: "1.0.0",
            packages: [],
            metadata: { public: isPublic },
          });
          const template = join(root, "capabilities", "feature", id, "template");
          mkdirSync(template, { recursive: true });
          writeFileSync(join(template, filename), content);
        }
        // A carrier is exempt only for the files its `registryPins` lists.
        writeCap(root, "feature/carrier", {
          id: "carrier",
          kind: "feature",
          version: "1.0.0",
          packages: [],
          metadata: { public: false, registryPins: [".npmrc.hbs"] },
        });
        const carrierTemplate = join(root, "capabilities", "feature", "carrier", "template");
        mkdirSync(carrierTemplate, { recursive: true });
        writeFileSync(join(carrierTemplate, ".npmrc.hbs"), "@scope:registry=https://x.example/\n");
        mkdirSync(join(carrierTemplate, "apps", "web"), { recursive: true });
        writeFileSync(
          join(carrierTemplate, "apps", "web", "bunfig.toml"),
          '[install.scopes]\n"@scope" = "https://registry.example/"\n',
        );
      },
      (root) => {
        expect(undeclaredRegistryConnectionState(root).toSorted()).toEqual([
          "feature/carrier/template/apps/web/bunfig.toml",
          "feature/npmrc/template/.npmrc.local",
          "feature/uv-index/template/pyproject.toml",
          "feature/uv-scalar/template/uv.toml",
          "feature/uv-source-public-private-index/template/pyproject.toml.hbs",
          "feature/uv-source-public-second-binding/template/pyproject.toml",
          "feature/uv-source-templated/template/pyproject.toml.hbs",
          "feature/uv-source-undeclared/template/pyproject.toml",
          "feature/uv-source-unparsed/template/pyproject.toml",
        ]);
      },
    );
  });

  test("registry pin carrier resolution fails loudly on absence and keeps every carrier", () => {
    withRepo(
      (root) => {
        writeCap(root, "feature/first", {
          id: "first",
          kind: "feature",
          version: "1.0.0",
          packages: [],
          metadata: { public: false },
        });
      },
      (root) => {
        expect(() => registryPinCarriers(readManifests(root))).toThrow(
          "no capability declares `metadata.registryPins`",
        );
        // The old boolean opt-in names no files, so it is rejected rather than read as "all".
        writeFileSync(
          join(root, "capabilities", "feature", "first", "capability.json"),
          JSON.stringify({
            id: "first",
            kind: "feature",
            version: "1.0.0",
            packages: [],
            metadata: { public: false, registryPins: true },
          }),
        );
        expect(() => registryPinCarriers(readManifests(root))).toThrow(
          "feature/first: metadata.registryPins must be a non-empty list",
        );
        writeCap(root, "feature/first", {
          id: "first",
          kind: "feature",
          version: "1.0.0",
          packages: [],
          metadata: { public: false, registryPins: [".npmrc.hbs"] },
        });
        writeCap(root, "feature/second", {
          id: "second",
          kind: "feature",
          version: "1.0.0",
          packages: [],
          metadata: { public: false, registryPins: ["pyproject.toml"] },
        });
        expect(registryPinCarriers(readManifests(root)).map(({ path }) => path)).toEqual([
          "feature/first",
          "feature/second",
        ]);
      },
    );
  });

  // npm strips a literal `.npmrc` from package tarballs. The `.npmrc.hbs` carrier survives and the
  // CLI renders it to the dotted destination, after its first install.
  test("mistral-design-system's .npmrc carrier matches the default package registry", () => {
    for (const rel of [".npmrc.hbs", ".npmrc.example"]) {
      expect(designSystemCarrier.canonical.get(rel), rel).toBe(
        buildNpmrc(DEFAULT_PACKAGE_REGISTRY),
      );
    }
  });

  // core is public. An app has one `.npmrc` and one root `bunfig.toml`, and the CLI fails `init`
  // when two capabilities render different bytes to one path, so core maps no private scope in
  // either and the capability that pins the private packages owns `.npmrc`.
  test("only a private carrier's .npmrc maps the private npm scopes", () => {
    const privateScope = /^\s*(?:@mistral(?:ai)?:registry\s*=|["']@mistral(?:ai)?["']\s*=)/m;
    const offenders = capabilityLocalIds.flatMap((id) => {
      const dir = templateDir(id);
      const carrier = carriers.find(({ template }) => template === dir);
      return walk(dir).flatMap((abs) => {
        const rel = relative(dir, abs);
        const allowed =
          carrier?.manifest.metadata?.public !== true &&
          carrier?.canonical.has(rel) === true &&
          rel.startsWith(".npmrc.");
        return !allowed && privateScope.test(readFileSync(abs, "utf8"))
          ? [`${id}/template/${rel}`]
          : [];
      });
    });
    expect(offenders).toEqual([]);
    expect(existsSync(join(templateDir("core"), ".npmrc.hbs"))).toBe(false);
  });

  // In package mode core's `bunfig.toml` replaces the one the CLI wrote, capability scope included,
  // so this table is what a later `bun add` of a capability package resolves through.
  test("core's bunfig scope table maps only the capability scope, to the default registry", () => {
    const bunfig = readFileSync(join(templateDir("core"), "bunfig.toml"), "utf8");
    expect(bunfig.endsWith(buildBunfigScopes(DEFAULT_PACKAGE_REGISTRY))).toBe(true);
    // SAFETY: repo-owned TOML; a shape mismatch fails the assertion below on `undefined`.
    const parsed = Bun.TOML.parse(bunfig) as {
      install?: { registry?: string; scopes?: Record<string, { url: string; token: string }> };
    };
    expect(parsed.install?.registry).toBe("https://registry.npmjs.org");
    expect(parsed.install?.scopes).toEqual({
      "@mistralai-capabilities": {
        url: PACKAGE_REGISTRIES[DEFAULT_PACKAGE_REGISTRY].ts,
        token: "$NODE_AUTH_TOKEN",
      },
    });
  });

  // Run the real generator rather than searching the file for the expected url: a match anywhere
  // -- a comment, the sibling `pypi` block -- would satisfy containment while the `mistralai`
  // index itself rotted. The committed file being a fixed point of `patchCorePyproject` asserts
  // both that the anchor still exists (it throws otherwise) and that the url under it is current.
  test("core's uv mistralai index matches the default package registry", () => {
    const pyproject = readCorePyprojectRaw();
    expect(patchCorePyproject(pyproject, DEFAULT_PACKAGE_REGISTRY)).toBe(pyproject);
  });

  // A generated app installs each packaged capability from the private index, whose simple API
  // serves no upload dates. The app's global `exclude-newer` cutoff then has no date to check the
  // candidate against, so `uv sync` warns ("is missing an upload date, but user provided ...") for
  // every packaged capability unless it is exempted with `exclude-newer-package = false`. That
  // list is hand-written in core's template pyproject; tie it to the set of capabilities that
  // actually publish a py dist, so adding one without exempting it fails here, not at a user's
  // first sync.
  test("core's template exempts every packaged capability from the exclude-newer cutoff", () => {
    // SAFETY: repo-owned pyproject; a shape mismatch fails this test on the empty default below.
    const parsed = Bun.TOML.parse(readCorePyprojectRaw()) as {
      tool?: {
        uv?: { "exclude-newer-package"?: Record<string, string | boolean> };
      };
    };
    const exempt = new Map(
      Object.entries(parsed.tool?.uv?.["exclude-newer-package"] ?? {}).map(([name, value]) => [
        normalizePyDistName(name),
        value,
      ]),
    );

    const expected = pyCapabilities()
      .map(({ id }) => pyDistNameFor(REGISTRY_ID, id))
      .toSorted();
    // Only this registry's own capability dists; the list also exempts unrelated first-party
    // packages (the SDK, guardrails, ...) that are not this invariant's concern.
    const present = [...exempt.keys()]
      .filter((name) => name.startsWith(`${REGISTRY_ID}-`))
      .toSorted();

    // Exact set: a new py capability with no entry fails here, and a stale entry for a removed
    // capability fails too.
    expect(present, "capability exemptions have drifted from the packaged capability set").toEqual(
      expected,
    );

    // `= false` is the exemption; any date value reintroduces the cutoff, and the warning with it.
    const notFalse = expected.filter((name) => exempt.get(name) !== false);
    expect(notFalse, `listed but not exempted (must be = false): ${notFalse.join(", ")}`).toEqual(
      [],
    );
  });

  // The committed pins are the default index's; every other index's are built at pack time. If the
  // generator ignored its argument, `--check` and both tests above would still pass while every
  // index shipped the same host -- so assert each id actually produces its own.
  test("the pin generator produces each index's own registry, not the default", () => {
    for (const id of PACKAGE_REGISTRY_IDS) {
      const { ts, py, pyUser, requiresAuth } = PACKAGE_REGISTRIES[id];
      if (requiresAuth) {
        const npmrc = buildNpmrc(id);
        expect(npmrc).toContain(`@mistralai:registry=${ts}`);
        expect(npmrc).toContain(`@mistral:registry=${ts}`);
        expect(npmrc).toContain(`${ts.replace(/^https:/, "")}:_authToken=\${NODE_AUTH_TOKEN}`);
        expect(npmrc).toContain(`(${new URL(ts).host})`);
        // core maps this scope, in bunfig.toml.
        expect(npmrc).not.toContain("@mistralai-capabilities");
      }

      const scopes = buildBunfigScopes(id);
      expect(scopes).toContain(`"@mistralai-capabilities" = `);
      expect(scopes).toContain(ts);
      expect(scopes).not.toContain('"@mistralai" =');
      expect(scopes).not.toContain('"@mistral" =');
      if (requiresAuth) {
        expect(scopes).toContain(`{ url = "${ts}", token = "$NODE_AUTH_TOKEN" }`);
      } else {
        expect(scopes).not.toContain("NODE_AUTH_TOKEN");
      }

      const pyproject = readCorePyprojectRaw();
      const projectedPyproject = patchCorePyproject(pyproject, id);
      if (requiresAuth) {
        expect(projectedPyproject).toContain(`name = "mistralai"\nurl = "${py}"`);
      } else {
        expect(projectedPyproject).not.toContain('name = "mistralai"');
        expect(projectedPyproject).not.toMatch(/index\s*=\s*["']mistralai["']/);
        // The table survives empty: the CLI appends each selected toolkit's binding to it.
        expect(projectedPyproject).toContain("\n[tool.uv.sources]\n");
      }

      // The uv index URL and Basic-auth username are one variant. `tools/uv.sh` carries the username
      // because local installs, CI, and Compose source the same wrapper.
      const pins = corePins(id);
      const rendered = new Map(pins.map((pin) => [basename(pin.path), pin.generate()]));
      if (requiresAuth) {
        expect(rendered.get("uv.sh")).toContain(`export MISTRAL_REGISTRY_USER=${pyUser}`);
        expect(rendered.get("gitignore")).toBe(canonicalCorePins.gitignore);
      } else {
        expect(rendered.get("uv.sh")).not.toContain("_registry_token");
        expect(rendered.get("uv.sh")).not.toContain("MISTRAL_REGISTRY_TOKEN");
        expect(rendered.get("uv.sh")).not.toContain("GEMFURY_PULL_TOKEN");
        expect(rendered.get("uv.sh")).not.toContain("MISTRAL_REGISTRY_USER");
        expect(rendered.get("uv.sh")).not.toContain(".env.registry");
        expect(rendered.get("uv.sh")).not.toContain(".env.gemfury");
      }
      // core's pins rewrite no CI file (the workflow left core with the automation split) and no
      // npm configuration (core ships none).
      expect([...rendered.keys()]).not.toContain("ci.yml.hbs");
      expect([...rendered.keys()].filter((name) => name.startsWith(".npmrc"))).toEqual([]);
    }
  });

  // Making the carrier public must fail its pack rather than map scopes nobody has claimed on npm.
  test("the private npm scopes have no anonymous projection", () => {
    expect(() => buildNpmrc("public")).toThrow("have no anonymous projection");
  });

  test("the anonymous pyproject projection applies exactly its reviewed removals and rewrites", () => {
    const privateIndex = `# \`explicit = true\`: consulted only for the names bound to it in \`[tool.uv.sources]\`. Credentials
# come from the environment (UV_INDEX_MISTRALAI_*, see tools/uv.sh), never committed. Do not re-add
# this host as UV_EXTRA_INDEX_URL: that makes it a general, higher-priority index, which shadows the
# public \`mistral-common\` / \`mistralai-vibe-sdk\` / \`mistralai-search-toolkit\` with older copies.
[[tool.uv.index]]
name = "mistralai"
url = "${PACKAGE_REGISTRIES[DEFAULT_PACKAGE_REGISTRY].py}"
explicit = true

# uv applies a source only where its package is a DIRECT requirement of a workspace member (an entry
# here is inherited by every member) and silently ignores it on a transitive one. So each capability
# binds its members' direct requirements in that member's own pyproject, next to the requirement
# (\`mistralai-guardrails\` in packages/py/guardrailing, for one), and the binding ships exactly when
# the capability is selected. The CLI adds one entry here per selected capability toolkit.
`;
    // Public PyPI serves upload dates, so the anonymous projection exempts nothing and drops the
    // whole table with its commentary.
    const privateExemptions = `# \`= false\` exempts a package from the \`exclude-newer\` cutoff. The list is every first-party
# Mistral distribution: \`exclude-newer\` guards against a hostile upload landing before anyone
# notices, a threat model that does not apply to a name Mistral publishes itself. This app's
# private index serves no upload dates, so a non-exempt first-party dep makes uv warn ("is missing
# an upload date, but user provided") on every sync. The \`mistralai-capabilities-*\` entries are the
# capability toolkits this registry itself publishes (\`<registry id>-<kind>-<capability id>\`); keep them
# in sync with the packaged capabilities in \`registry.json\`.
exclude-newer-package = { mistralai = false, mistralai-evaluations = false, mistralai-guardrails = false, mistralai-search-toolkit = false, mistralai-search-toolkit-storage-s3 = false, mistralai-search-toolkit-storage-gcs = false, mistralai-search-toolkit-storage-azure = false, mistralai-workflows-plugins-evaluations = false, mistralai-workflows-plugins-search = false, mistralai-agents = false, mistralai-vibe-harness = false, mistralai-vibe-sdk = false, mistral-vibe = false, mistralai-workflows = false, mistralai-workflows-plugins-mistralai = false, mistralai-capabilities-backend-fastapi = false, mistralai-capabilities-feature-fastapi-auth = false, mistralai-capabilities-feature-fastapi-workflows-auth = false, mistralai-capabilities-feature-mcp-apps = false, mistralai-capabilities-backend-workflows = false, mistralai-capabilities-feature-agents = false, mistralai-capabilities-feature-chat = false, mistralai-capabilities-feature-evals = false, mistralai-capabilities-feature-experiments = false, mistralai-capabilities-feature-guardrailing = false, mistralai-capabilities-feature-guardrailing-eval = false, mistralai-capabilities-feature-document-annotation-ui = false, mistralai-capabilities-feature-observability = false, mistralai-capabilities-database-bucket = false, mistralai-capabilities-feature-custom-rbac = false, mistralai-capabilities-feature-search = false, mistralai-capabilities-feature-speech = false, mistralai-capabilities-deployment-apps = false }
`;

    const expected = canonicalCorePins.pyproject
      .replace(privateIndex, "")
      .replace(privateExemptions, "")
      .replace(
        `# Dual-published: the private index also carries these names but only at much older versions.
# Bind them to public PyPI so a stray extra-index can never silently downgrade them.`,
        `# Bind these dual-published names to public PyPI so another configured index can never silently
# downgrade them to older copies.`,
      )
      .replace(
        `# Public-only, unlike its \`mistralai-workflows-plugins-*\` siblings above: the Workflows Search
# Plugin ships on PyPI alongside the toolkit release it stages. Bound here because the search
# capability's own binding reaches direct requirements of that member only.`,
        `# The Workflows Search Plugin ships on PyPI alongside the toolkit release it stages. Bound here
# because the search capability's own binding reaches direct requirements of that member only.`,
      )
      .replace(
        `# Dual-published and, until the search capability declared it directly, transitive. That put it
# outside the reach of this table and let \`first-index\` serve it from the private index's older
# copies. See the note beside its entry in the capability's own pyproject.toml.`,
        `# Dual-published and, until the search capability declared it directly, transitive. Explicitly
# binding it here keeps resolution on the public release. See the note beside its entry in the
# capability's own pyproject.toml.`,
      );

    expect(patchCorePyproject(canonicalCorePins.pyproject, "public")).toBe(expected);
  });

  test("the anonymous uv-wrapper projection applies exactly its credential edits", () => {
    const wrapper = canonicalCorePins.uvWrapper;
    // Extract the sentinel-delimited block independently of the generator's own regex, then rebuild
    // the expected file, so the assertion pins the exact public comment the generator substitutes.
    const beginIndex = wrapper.indexOf("# --- BEGIN private-index credentials");
    const endMarker = "# --- END private-index credentials ---\n";
    const credentialBlock = wrapper.slice(
      beginIndex,
      wrapper.indexOf(endMarker) + endMarker.length,
    );
    const publicComment = "# No package-index authentication is required for this audience.\n";

    expect(patchRegistryUvWrapper(wrapper, "public")).toBe(
      wrapper.replace(credentialBlock, publicComment),
    );

    // Internal (authenticated) variants keep the wrapper byte for byte.
    for (const id of INTERNAL_PACKAGE_REGISTRY_IDS) {
      expect(patchRegistryUvWrapper(wrapper, id)).toBe(wrapper);
    }

    // The public projection cannot leak the credential helpers or export a pull token, yet keeps the
    // index pinning and the uv exec.
    const projected = patchRegistryUvWrapper(wrapper, "public");
    expect(projected).not.toContain("_registry_token");
    expect(projected).not.toContain("UV_INDEX_MISTRALAI");
    expect(projected).not.toContain("MISTRAL_REGISTRY_TOKEN");
    expect(projected).toContain('exec uv "$@"');
    expect(projected).toContain("UV_DEFAULT_INDEX");
  });

  test("the anonymous gitignore projection applies exactly its registry edits", () => {
    expect(patchRegistryGitignore(canonicalCorePins.gitignore, "public")).toBe(
      canonicalCorePins.gitignore
        .replace(".env.registry\n.env.gemfury\n", "")
        .replace(
          "# Private registry auth (contains tokens)",
          "# Local package-manager configuration (may contain tokens)",
        ),
    );
  });

  test("the public exclude-newer exemptions are a subset of names bound to public PyPI", () => {
    const projected = patchCorePyproject(canonicalCorePins.pyproject, "public");
    // SAFETY: this is the generated repo-owned TOML projection; absent/malformed fields become
    // empty defaults below and fail the non-empty/subset assertions rather than granting access.
    const parsed = Bun.TOML.parse(projected) as {
      tool?: {
        uv?: {
          "exclude-newer-package"?: Record<string, boolean | string>;
          sources?: Record<string, { index?: string }>;
        };
      };
    };
    const pypiBoundNames = new Set(
      Object.entries(parsed.tool?.uv?.sources ?? {}).flatMap(([name, source]) =>
        source.index === "pypi" ? [name] : [],
      ),
    );
    const exemptions = Object.keys(parsed.tool?.uv?.["exclude-newer-package"] ?? {});

    // Core may have no direct PyPI source bindings after they move to their owning capabilities.
    expect(exemptions.filter((name) => !pypiBoundNames.has(name))).toEqual([]);
  });

  test("every private-registry reference in core's template is audience-projected and absent publicly", () => {
    const coreTemplate = templateDir("core");
    const projected = new Map(corePins("public").map((pin) => [pin.path, pin.generate()]));
    const privateRegistryReference =
      /MISTRAL_REGISTRY_TOKEN|NODE_AUTH_TOKEN|UV_INDEX_MISTRALAI|REGISTRY_PY_USER|GEMFURY_PULL_TOKEN|\.env\.(?:registry|gemfury)|private (?:package )?(?:index|registry)|pypi\.fury\.io|npm-proxy\.fury\.io|dl\.cloudsmith\.io|npm\.cloudsmith\.io/i;
    const unprojected: string[] = [];
    const residual: string[] = [];
    for (const abs of walk(coreTemplate)) {
      const raw = readFileSync(abs, "utf8");
      const rel = relative(coreTemplate, abs);
      if (privateRegistryReference.test(raw) && !projected.has(abs)) unprojected.push(rel);
      if (privateRegistryReference.test(projected.get(abs) ?? raw)) residual.push(rel);
    }

    expect(
      unprojected,
      "private-registry template carriers must be in core's projected file set",
    ).toEqual([]);
    expect(residual, "anonymous core template projection retains private-registry state").toEqual(
      [],
    );
  });

  test("the public projection removes dotted-table source bindings to the private index", () => {
    const withDottedSource = canonicalCorePins.pyproject.replace(
      "\n[tool.uv.sources]\n",
      '\n[tool.uv.sources.private-package]\nindex = "mistralai"\n\n[tool.uv.sources]\n',
    );
    const projected = patchCorePyproject(withDottedSource, "public");

    expect(projected).not.toContain("[tool.uv.sources.private-package]");
    expect(projected).not.toMatch(/index\s*=\s*["']mistralai["']/);
  });

  test("the anonymous projection fails closed when the private index declaration drifts", () => {
    const drifted = canonicalCorePins.pyproject.replace(
      'name = "mistralai"',
      'name = "unexpected"',
    );

    expect(() => patchCorePyproject(drifted, "public")).toThrow(
      "expected exactly one `mistralai` uv index",
    );
  });

  test("the anonymous projection fails closed on a scalar uv index aimed at an internal host", () => {
    const withScalarIndex = canonicalCorePins.pyproject.replace(
      "[tool.uv]\n",
      '[tool.uv]\nindex-url = "https://pypi.fury.io/mistralai/"\n',
    );

    expect(() => patchCorePyproject(withScalarIndex, "public")).toThrow(
      "scalar uv index setting for an internal registry host",
    );
  });

  test("the anonymous projection fails closed on an unrecognized private-index reference", () => {
    const withResidualReference = canonicalCorePins.pyproject.replace(
      "\n[tool.uv.sources]\n",
      '\n[tool.uv.sources]\nprivate-package = {\n  index = "mistralai"\n}\n',
    );

    expect(() => patchCorePyproject(withResidualReference, "public")).toThrow(
      "anonymous projection retains a source bound to the `mistralai` index",
    );
  });

  test("the public projection removes a duplicate credentialed alias regardless of URL spelling", () => {
    const duplicateUrl = readCorePyprojectRaw().replace(
      `url = "${PACKAGE_REGISTRIES[DEFAULT_PACKAGE_REGISTRY].py}"`,
      'url = "https://pypi.org/simple/"',
    );
    const projected = patchCorePyproject(duplicateUrl, "public");

    expect(projected).toContain('name = "pypi"\nurl = "https://pypi.org/simple"');
    expect(projected).not.toContain('name = "mistralai"');
    expect(projected).not.toContain('url = "https://pypi.org/simple/"');
    expect(projected).not.toMatch(/index\s*=\s*["']mistralai["']/);
    expect(projected).toContain("\n[tool.uv.sources]\n");
  });

  test.skipIf(!Bun.which("uv"))(
    "uv sends no Authorization header for the generated public projection",
    async () => {
      const authorizations: (string | null)[] = [];
      const server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          authorizations.push(request.headers.get("authorization"));
          return new Response("not found", { status: 404 });
        },
      });
      const root = mkdtempSync(join(tmpdir(), "cap-public-uv-"));
      try {
        let pyproject = patchCorePyproject(readCorePyprojectRaw(), "public");
        pyproject = pyproject
          .replace('requires-python = ">=3.12,<3.15"', 'requires-python = ">=3.11"')
          .replace(
            /^dependencies = \[[\s\S]*?^\]/m,
            'dependencies = ["authorization-leak-probe==1.0.0"]',
          )
          .replace(/\n\[dependency-groups\][\s\S]*?(?=\n\[tool\.uv\])/, "")
          .replace(/\n\[tool\.uv\.workspace\][\s\S]*$/, "\n")
          .replace(
            'url = "https://pypi.org/simple"',
            `url = "http://127.0.0.1:${server.port}/simple"`,
          );
        writeFileSync(join(root, "pyproject.toml"), pyproject);

        const process = Bun.spawn([Bun.which("uv")!, "lock", "--no-cache"], {
          cwd: root,
          env: {
            HOME: root,
            PATH: globalThis.process.env.PATH ?? "",
            NO_PROXY: "127.0.0.1",
            UV_PYTHON_DOWNLOADS: "never",
            UV_INDEX_MISTRALAI_USERNAME: "internal-user",
            UV_INDEX_MISTRALAI_PASSWORD: "fake-internal-token",
            MISTRAL_REGISTRY_TOKEN: "fake-internal-token",
            NODE_AUTH_TOKEN: "fake-internal-token",
          },
          stdout: "pipe",
          stderr: "pipe",
        });
        const [exitCode, stderr] = await Promise.all([
          process.exited,
          new Response(process.stderr).text(),
        ]);

        expect(exitCode).not.toBe(0); // The listener deliberately serves no package.
        expect(
          stderr.includes("No solution found") || stderr.includes("Failed to fetch"),
          `uv should fail with a resolution or fetch error, got:\n${stderr}`,
        ).toBe(true);
        expect(stderr).not.toContain("Failed to parse");
        expect(stderr).not.toContain("references an undeclared index");
        expect(authorizations.length, stderr).toBeGreaterThan(0);
        expect(authorizations).toEqual(authorizations.map(() => null));
      } finally {
        server.stop(true);
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  // A username that is the same string for every index is the failure this field exists to stop:
  // it would look configured, pass every per-index assertion above, and still 401 one of them.
  test("each index declares its own uv basic-auth username", () => {
    const users = PACKAGE_REGISTRY_IDS.map((id) => PACKAGE_REGISTRIES[id].pyUser);
    expect(new Set(users).size, `pyUser is not per-index: ${users.join(", ")}`).toBe(users.length);
  });

  // A generated app is pointed at one index and should read as if that were the only one. Naming
  // the vendors, or explaining how they differ, leaks a registry-side concern into a user's repo
  // and goes stale the moment the set changes. The mechanism stays; the comparison does not.
  test("no capability template names a package-index vendor", () => {
    // Identifiers we deliberately kept are not prose: the Helm secret key (never typed by a user,
    // and mapped from an external-secrets path this repo cannot rename alone), and the legacy env
    // var and dotfile an older app still carries. The BuildKit secret id is `registry_token`.
    const KEPT = /gemfury-token|gemfuryToken|GEMFURY_PULL_TOKEN|\.env\.gemfury/g;
    const VENDOR = /gemfury|cloudsmith/i;
    const publicCore = new Map(corePins("public").map((pin) => [pin.path, pin.generate()]));
    // A private carrier's pins have no anonymous projection; they name only the host of the index
    // they are generated for, which the foreign-host test below covers.
    const privatePins = new Set(
      carriers
        .filter(({ manifest }) => manifest.metadata?.public !== true)
        .flatMap(({ canonical, template }) =>
          registryPins(DEFAULT_PACKAGE_REGISTRY, canonical, template).map(({ path }) => path),
        ),
    );
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const dir = templateDir(id);
      if (!existsSync(dir)) continue;
      for (const abs of walk(dir)) {
        if (privatePins.has(abs)) continue;
        for (const [n, line] of (publicCore.get(abs) ?? readFileSync(abs, "utf8"))
          .split("\n")
          .entries()) {
          if (VENDOR.test(line.replace(KEPT, ""))) {
            offenders.push(`${id}/template/${relative(dir, abs)}:${n + 1}`);
          }
        }
      }
    }
    expect(
      offenders,
      "a generated app should not know which index it came from -- describe the value as a " +
        "property of this app's index instead of comparing the vendors",
    ).toEqual([]);
  });

  // Two halves of one invariant: after the swap runs for an index, nothing an app receives may
  // name a DIFFERENT index's host. A stray Gemfury URL survives into the Cloudsmith tarball and
  // 401s there, and it does not have to live in a template a capability author thought about.
  //
  // The generated files are checked by running the generator, not by exempting the filename:
  // core's pyproject is only partly generated, so skipping the whole file would let a host added
  // to the sibling `pypi` index, a comment, or any other setting ride along untouched.
  test("no capability template leaves a foreign registry host in any index's variant", () => {
    // SAFETY: keys are exactly PACKAGE_REGISTRY_IDS, which `Object.fromEntries` widens to string.
    const hostsByRegistry = Object.fromEntries(
      PACKAGE_REGISTRY_IDS.map((id) => [
        id,
        PACKAGE_REGISTRY_LANGUAGES.map((lang) => new URL(PACKAGE_REGISTRIES[id][lang]).host),
      ]),
    ) as Record<PackageRegistryId, string[]>;
    // Public indexes are also legitimate upstreams for third-party packages in every generated
    // app. Only authenticated internal capability hosts are forbidden in another audience.
    const internalHosts = INTERNAL_PACKAGE_REGISTRY_IDS.flatMap((id) => hostsByRegistry[id]);
    // Keyed by path so the exemption cannot drift from what each carrier's pins actually rewrite,
    // and only for the indexes that carrier is packed for.
    const rewritten = new Map(
      carriers.flatMap((carrier) =>
        registryPins(DEFAULT_PACKAGE_REGISTRY, carrier.canonical, carrier.template).map(
          ({ path }) =>
            [
              path,
              carrierRegistryIds(carrier).map((registryId) => ({
                registryId,
                variant: registryPins(registryId, carrier.canonical, carrier.template)
                  .find((pin) => pin.path === path)!
                  .generate(),
              })),
            ] as const,
        ),
      ),
    );

    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const dir = templateDir(id);
      if (!existsSync(dir)) continue;
      for (const abs of walk(dir)) {
        const rel = `${id}/template/${relative(dir, abs)}`;
        const variants = rewritten.get(abs);
        if (!variants) {
          // Not rewritten by anything: it ships as-is to every index, so it may name no host.
          const text = readFileSync(abs, "utf8");
          offenders.push(
            ...internalHosts.filter((h) => text.includes(h)).map((h) => `${rel}: ${h}`),
          );
          continue;
        }
        // Rewritten: each index's variant may name that index's hosts and no other's.
        for (const { registryId, variant } of variants) {
          const own = hostsByRegistry[registryId];
          offenders.push(
            ...internalHosts
              .filter((h) => !own.includes(h) && variant.includes(h))
              .map((h) => `${rel} [${registryId} variant]: ${h}`),
          );
        }
      }
    }

    expect(
      offenders,
      "each of these reaches an index that cannot serve it -- a plain template file ships one " +
        "fixed host to every consumer, and a generated file that still names another index's " +
        "host after its own swap was never fully swapped",
    ).toEqual([]);
  });

  // The app authenticates whichever index it was generated from with one token, so the variable
  // a user is told to set carries no vendor name: a Cloudsmith customer exporting `GEMFURY_*` is
  // the same category of wrong as a Cloudsmith app pinned to a Gemfury host. Reading the old name
  // as a fallback is fine -- an app generated before the rename has it in a gitignored `.env` we
  // cannot migrate -- so only an ASSIGNMENT of it is an offence, which is what a user copies.
  test("no capability template asks a user to set a vendor-named registry token", () => {
    // `FOO=` or `export FOO=` at the head of a line, in shell, dotenv, compose, or YAML `env:`.
    // A `${FOO:-...}` fallback is deliberately not matched: it reads, it does not instruct.
    const assignment = /^[\s#-]*(?:export\s+|- )?GEMFURY_[A-Z_]*\s*[:=]/m;
    const offenders: string[] = [];
    for (const id of capabilityLocalIds) {
      const dir = templateDir(id);
      if (!existsSync(dir)) continue;
      for (const abs of walk(dir)) {
        if (assignment.test(readFileSync(abs, "utf8"))) {
          offenders.push(`${id}/template/${relative(dir, abs)}`);
        }
      }
    }
    expect(
      offenders,
      "these assign a Gemfury-named token in a generated app -- use MISTRAL_REGISTRY_TOKEN, the " +
        "carrier for whichever index the app was generated from",
    ).toEqual([]);
  });
});
