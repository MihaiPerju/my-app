# Registry test suite

These are repository-level contract tests. They inspect the committed registry, capability
manifests, package metadata, and template source without generating an application. They run on
every pull request through:

```text
bun run test
  -> turbo test
     -> tests/registry/package.json: bun test
```

Run only this package from the repository root with `bun run test:registry`, or pass a directory or
file to Bun for a focused run, such as `bun test tests/registry/release`.

Checks that need the CLI to compose an application belong in `scripts/e2e/`, not here. That suite
is slower and exercises the generated result; this suite is the fast feedback layer for properties
that can be proven directly from repository files.

## Directory map

| Directory      | Responsibility                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------- |
| `descriptor/`  | `registry.json`, capability graph, package-zone, environment, and descriptor-package invariants.        |
| `templates/`   | Cross-capability template ownership, Handlebars safety, toolchain pins, and dependency coherence.       |
| `composition/` | Exhaustive capability-selection behavior for Compose, APISIX, init, runbooks, and focused overlays.     |
| `compliance/`  | Public-artifact forbidden-reference policy and packed-archive scanner behavior.                         |
| `release/`     | Release/RC policy, package preparation and packing, index provenance, registry variants, and dist tags. |
| `coverage/`    | Meta-tests proving capability code has runner-collectable tests and those tests are actually wired.     |
| `e2e/`         | Unit-level regression tests for the Python E2E harness itself; these do not generate a full app.        |
| `inventory/`   | The reviewed snapshot of paths contributed by each capability template.                                 |
| `anti-slop/`   | Rule fixtures, their diagnostic-count snapshot, and canonical-versus-vendored plugin parity.            |
| `support/`     | Import-only filesystem, manifest, selection-matrix, and registry-fixture helpers.                       |

The directory is the ownership boundary: put a new test with the contract it protects. Shared
filesystem mechanics may go in `support/`; policy assertions should remain in the relevant test so
their failure messages and rationale stay together.

## Why there are executable files here

Most files are tests. The three `*.gen.ts` files are deliberate maintenance commands for committed
derived data:

| Command                                                  | Run when                                                            | Output                                       |
| -------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| `bun tests/registry/inventory/template-inventory.gen.ts` | An intentional template path is added or removed.                   | `inventory/template-inventory.snapshot.json` |
| `bun tests/registry/anti-slop/rules.gen.ts`              | A lint rule or its fixtures intentionally change diagnostic counts. | `anti-slop/rules.snapshot.json`              |
| `bun tests/registry/anti-slop/vendor.gen.ts`             | The canonical plugin under `tools/oxlint/anti-slop/` changes.       | The copy shipped by `core/template/`         |

They are scripts because each output has one mechanical source of truth and should not be edited by
hand. They live beside the tests that verify their output so the update command, snapshot, fixtures,
and drift guard are one reviewable unit. They are not run during `bun test`: tests must detect drift,
not silently rewrite the checkout.

The files under `anti-slop/fixtures/` intentionally contain invalid or unusually shaped TypeScript.
They are excluded from the package type-check and normal formatter; `rules.test.ts` runs oxlint over
them with the isolated fixture configuration instead. Generated `*.snapshot.json` files are also
excluded from the formatter so rerunning their generators is byte-stable.

## Test design boundary

- Use repository tests for static facts: graph validity, file ownership, package metadata, source
  guards, and pure release-policy functions.
- Use subprocess smoke tests in `release/` or `compliance/` when release packing or artifact
  inspection is the subject; they create and remove their own temporary workspaces.
- Use `scripts/e2e/generate_app.py` for end-to-end CLI rendering, generated-workspace, Helm, Docker,
  and live-stack behavior. Repository composition tests may project the manifest graph only to prove
  static ownership and source-gating invariants; they must not claim CLI conformance. `support/selection.ts`
  owns that pure projection and the small Handlebars subset needed by those tests.
